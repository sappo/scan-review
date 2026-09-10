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

# Record this host's LAN address as a setting, so the post-install notes can
# name it exactly instead of telling the operator to go and find it.
#
# Purely informational: nothing acts on this value. It is the source address
# the kernel would use to reach the configured range, which is the right answer
# whenever that range is one this host is actually on. If it is not, the value
# falls back to the default route's source rather than failing - acceptable for
# a documentation string, and not worth a CIDR implementation in shell.
record_lan_ip() {
    local first
    first=$(echo "$lan_subnet" | tr ',' ' ' | awk '{print $1}' | cut -d/ -f1)
    lan_ip=$(ip -4 route get "$first" 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)
    ynh_app_setting_set --app="$app" --key=lan_ip --value="${lan_ip:-this server}"
}
