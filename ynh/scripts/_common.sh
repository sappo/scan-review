#!/bin/bash
# Shared between install and upgrade so the two cannot drift.

# opencv-python-headless and numpy are large wheels; a venv build needs more
# than the default pip working space on a small box.
build_venv() {
    pushd "$install_dir" >/dev/null
        ynh_exec_as_app python3 -m venv --upgrade-deps venv
        ynh_exec_as_app venv/bin/pip install --no-cache-dir --requirement requirements.txt
    popd >/dev/null
}

# The scanner's bearer token. Generated once and kept in app settings so an
# upgrade does not silently invalidate the Pi's credential.
ensure_ingest_token() {
    ingest_token=$(ynh_app_setting_get --app="$app" --key=ingest_token)
    if [ -z "${ingest_token:-}" ]; then
        ingest_token=$(ynh_string_random --length=48)
        ynh_app_setting_set --app="$app" --key=ingest_token --value="$ingest_token"
    fi
}

# uvicorn reads this; kept out of the unit file so it is not world-readable in
# `systemctl cat` or in ps.
write_env_file() {
    ynh_config_add --template="env" --destination="$install_dir/.env"
    chmod 600 "$install_dir/.env"
    chown "$app:$app" "$install_dir/.env"
}

# The nginx access rule, as ONE line for __LAN_ACCESS__.
#
# Simple __VAR__ substitution, not jinja: ynh_config_add_nginx calls
# ynh_config_add WITHOUT --jinja, so {% if %} in the template would be copied
# through literally and nginx would refuse to start. Substitution is sed with
# an @ delimiter, so the slash in a CIDR is safe.
#
# Every __VAR__ in a template must have a shell variable set or ynh_config_add
# calls ynh_die, so this has to run before ynh_config_add_nginx in install,
# upgrade AND config.
set_lan_access() {
    lan_only=$(ynh_app_setting_get --app="$app" --key=lan_only)
    lan_subnet=$(ynh_app_setting_get --app="$app" --key=lan_subnet)
    lan_only="${lan_only:-1}"
    lan_subnet="${lan_subnet:-192.168.1.0/24}"
    ynh_app_setting_set --app="$app" --key=lan_only --value="$lan_only"
    ynh_app_setting_set --app="$app" --key=lan_subnet --value="$lan_subnet"
    if [ "$lan_only" = "1" ]; then
        # One allow per range. A home LAN is dual-stack: the same client may
        # arrive as 192.168.x.y or as an IPv6 ULA depending on what DNS handed
        # it, and refusing one of those looks like the app being broken rather
        # than a firewall decision.
        lan_access=""
        for range in ${lan_subnet//,/ }; do
            lan_access="${lan_access}allow ${range}; "
        done
        lan_access="${lan_access}deny all;"
    else
        # SSO is the only gate. Set deliberately via the config panel.
        lan_access="allow all;"
    fi
}

# The host's own address inside the configured LAN range, which is what LAN
# clients must be sent to. Derived rather than asked for: it is already implied
# by lan_subnet, and a second question that must agree with the first is a
# question answered wrongly.
lan_ip_for_subnet() {
    python3 - "$lan_subnet" <<'PYEOF'
import ipaddress, json, subprocess, sys
nets = []
for raw in sys.argv[1].replace(",", " ").split():
    try:
        nets.append(ipaddress.ip_network(raw, strict=False))
    except ValueError:
        pass
out = json.loads(subprocess.check_output(
    ["ip", "-j", "-4", "addr", "show", "scope", "global"]))
for iface in out:
    for a in iface.get("addr_info", []):
        ip = ipaddress.ip_address(a["local"])
        if any(ip in n for n in nets):
            print(ip)
            raise SystemExit(0)
raise SystemExit(1)
PYEOF
}

# Make this host answer DNS for its own domain on the LAN.
#
# The same approach the adguardhome package uses - a file in /etc/dnsmasq.d/,
# which is the supported place for additions and is checksummed, unlike
# /etc/dnsmasq.conf which YunoHost regenerates.
#
# Validated before dnsmasq is restarted. A bad file here does not merely break
# this app: dnsmasq would fail to start and the whole host loses name
# resolution, mail and updates included.
configure_lan_dns() {
    local target="/etc/dnsmasq.d/$app"
    if [ "${lan_dns:-0}" != "1" ] || [ "${lan_only:-0}" != "1" ]; then
        remove_lan_dns
        return
    fi

    lan_ip=$(lan_ip_for_subnet) || ynh_die \
        "No address of this host falls inside $lan_subnet, so LAN clients cannot be pointed at it. Fix the range, or turn off lan_dns."

    ynh_config_add --template="dnsmasq" --destination="$target"

    # Absolute path: dnsmasq lives in /usr/sbin, and relying on PATH here
    # would silently turn this safety check into a no-op that always "fails".
    if ! /usr/sbin/dnsmasq --test --conf-file="$target" 2>/dev/null; then
        ynh_safe_rm "$target"
        ynh_die "Generated dnsmasq config was rejected; left DNS untouched."
    fi
    ynh_systemctl --service=dnsmasq --action=restart
}

remove_lan_dns() {
    local target="/etc/dnsmasq.d/$app"
    if [ -e "$target" ]; then
        ynh_safe_rm "$target"
        ynh_systemctl --service=dnsmasq --action=restart
    fi
}
