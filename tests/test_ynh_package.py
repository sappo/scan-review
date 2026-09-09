"""Static checks on the YunoHost package.

This package has never been through `yunohost app install`, and the failures it
can produce are all install-time and all fatal: a helper that was renamed
between versions, a __VAR__ with no shell variable behind it, or jinja syntax
in a template that is rendered without jinja. Each of those aborts an install
or, worse, writes an nginx config that refuses to load.

Checked against the helper set actually installed on this host where possible,
so the tests fail if YunoHost is upgraded and something moves.
"""
import re
import tomllib
from pathlib import Path

import pytest

YNH = Path(__file__).resolve().parent.parent / "ynh"
HELPERS = Path("/usr/share/yunohost/helpers.v2.1.d")
CONFS = sorted((YNH / "conf").glob("*"))
SCRIPTS = sorted(p for p in (YNH / "scripts").glob("*") if p.is_file())


def test_manifest_is_valid_packaging_v2():
    m = tomllib.load((YNH / "manifest.toml").open("rb"))
    assert m["packaging_format"] == 2
    assert m["integration"]["helpers_version"] == "2.1"
    for required in ("id", "name", "version", "maintainers"):
        assert m.get(required), f"manifest missing {required}"
    assert m["upstream"]["license"], "license is mandatory"


def test_the_scanner_path_is_exempt_and_pinned_that_way():
    perms = tomllib.load((YNH / "manifest.toml").open("rb"))["resources"]["permissions"]
    assert perms["ingest"]["url"] == "/api/ingest"
    # The Pi cannot complete an SSO login, so this must be reachable...
    assert perms["ingest"]["allowed"] == "visitors"
    # ...and must not be quietly widened or closed from the admin UI.
    assert perms["ingest"]["protected"] is True
    # SSOwat must not inject an operator identity onto the scanner's path.
    assert perms["ingest"]["auth_header"] is False
    # The UI is private by default. These are bank and medical documents.
    assert perms["main"]["auth_header"] is True


def test_no_template_uses_jinja_syntax():
    """ynh_config_add_nginx calls ynh_config_add WITHOUT --jinja, so a {% %}
    would be copied through literally and nginx would refuse to start."""
    for conf in CONFS:
        body = conf.read_text()
        assert "{%" not in body and "{{" not in body, f"{conf.name} uses jinja"


def test_every_template_variable_is_set_by_a_script():
    """_ynh_replace_vars calls ynh_die if a __VAR__ has no shell variable, so an
    unset one is a failed install, not a blank line."""
    # Provided by the core from the manifest's install questions and resources.
    from_core = {"app", "domain", "path", "port", "install_dir", "data_dir"}
    script_text = "\n".join(p.read_text() for p in SCRIPTS)
    for conf in CONFS:
        for tag in set(re.findall(r"__([A-Z0-9_]+)__", conf.read_text())):
            var = tag.lower()
            if var in from_core:
                continue
            assert re.search(rf"\b{var}=", script_text), (
                f"__{tag}__ in {conf.name} is never assigned in any script")


@pytest.mark.skipif(not HELPERS.is_dir(), reason="YunoHost helpers not installed")
def test_every_helper_called_exists_in_the_installed_v2_1_set():
    """Helper names changed between packaging versions; a v1 name is silently
    undefined rather than an error at write time."""
    available = set()
    for f in HELPERS.iterdir():
        if f.is_file():
            available |= set(re.findall(r"^([a-z_0-9]+)\s*\(\)", f.read_text(errors="ignore"),
                                        re.M))
    called = set()
    for p in SCRIPTS:
        called |= set(re.findall(r"\b(ynh_[a-z0-9_]+)", p.read_text()))
    # Defined by the app's own _common.sh, not by YunoHost.
    called -= {"ynh_app_config_apply", "ynh_app_config_run"}
    missing = sorted(c for c in called if c not in available)
    assert not missing, f"helpers not in the installed v2.1 set: {missing}"


@pytest.mark.skipif(not HELPERS.is_dir(), reason="YunoHost helpers not installed")
def test_no_helper_renamed_away_in_v2_1_is_used():
    """These are the v1/v2.0 spellings. Using one is the classic packaging-v2
    mistake and fails at install rather than at review."""
    retired = ["ynh_add_nginx_config", "ynh_remove_nginx_config",
               "ynh_add_systemd_config", "ynh_remove_systemd_config",
               "ynh_systemd_action", "ynh_add_config", "ynh_secure_remove",
               "ynh_exec_as", "ynh_permission_create", "ynh_add_fpm_config",
               "ynh_use_logrotate", "ynh_restore_file"]
    body = "\n".join(p.read_text() for p in SCRIPTS)
    used = [r for r in retired if re.search(rf"\b{r}\b", body)]
    assert not used, f"retired helper names: {used}"


def test_lan_access_renders_both_ways():
    """The one line that decides whether these documents are reachable from
    the internet. Rendered by sed with an @ delimiter, so the CIDR's slash is
    safe - but the two branches must both produce valid nginx."""
    tmpl = (YNH / "conf" / "nginx.conf").read_text()
    assert "__LAN_ACCESS__" in tmpl
    restricted = tmpl.replace("__LAN_ACCESS__", "allow 192.168.1.0/24; deny all;")
    assert "allow 192.168.1.0/24; deny all;" in restricted
    assert restricted.count("{") == restricted.count("}")
    opened = tmpl.replace("__LAN_ACCESS__", "allow all;")
    assert "deny all" not in opened
    assert opened.count("{") == opened.count("}")


def test_the_config_panel_offers_the_toggle():
    panel = tomllib.load((YNH / "config_panel.toml").open("rb"))
    access = panel["main"]["access"]
    assert access["lan_only"]["type"] == "boolean"
    assert access["lan_only"]["default"] == "1", "must default to LAN-only"
    assert access["lan_subnet"]["visible"] == "lan_only == '1'"


def test_the_lan_range_is_asked_at_install_not_after():
    """The nginx allowlist is written during install. A default that does not
    match the operator's network makes the UI unreachable the moment it exists,
    and the place to fix it would be the config panel of the app you can no
    longer reach."""
    m = tomllib.load((YNH / "manifest.toml").open("rb"))
    assert "lan_subnet" in m["install"], "LAN range must be an install question"
    assert "lan_only" in m["install"]
    assert m["install"]["lan_only"]["default"] == "1", "must default to restricted"


def test_the_unit_does_not_sandbox_away_its_own_data_dir():
    """ProtectHome=yes mounts an empty tmpfs over /home for the service, and
    YunoHost's data_dir lives at /home/yunohost.app/<app>. The app then cannot
    stat() its own spool directory and dies at import with EACCES - which is
    exactly how the first real install failed. ReadWritePaths does not rescue
    it. Cheap to reintroduce while 'hardening', and it only fails on a real
    install, never in the test suite."""
    unit = (YNH / "conf" / "systemd.service").read_text()
    active = [ln.strip() for ln in unit.splitlines()
              if ln.strip() and not ln.strip().startswith("#")]
    offenders = [ln for ln in active if ln.startswith("ProtectHome=")
                 and ln.split("=", 1)[1].strip() not in ("no", "false")]
    assert not offenders, f"unit would hide its own data_dir: {offenders}"
    # The protection that does apply, and should stay.
    assert any(ln.startswith("ProtectSystem=") for ln in active)
    assert any(ln.startswith("NoNewPrivileges=") for ln in active)


def test_the_allowlist_accepts_several_ranges():
    """A home LAN is dual-stack. Once the app's own DNS answer points clients at
    this host, they may arrive over IPv4 or over an IPv6 ULA depending on what
    the resolver handed them and which the client preferred - and an IPv4-only
    allowlist refuses the second in a way that looks like the app being broken.
    """
    common = (YNH / "scripts" / "_common.sh").read_text()
    assert "${lan_subnet//,/ }" in common, "ranges must be split, not used whole"
    panel = tomllib.load((YNH / "config_panel.toml").open("rb"))
    rx = panel["main"]["access"]["lan_subnet"]["pattern"]["regexp"]
    import re
    ok = re.compile(rx)
    assert ok.match("192.168.1.0/24")
    assert ok.match("192.168.1.0/24 fd00::/8")
    assert ok.match("192.168.1.0/24, fdff:d052:40d9::/48")
    assert not ok.match("not-a-range")


def test_host_dns_changes_are_validated_before_being_applied():
    """This app writes /etc/dnsmasq.d/ and restarts dnsmasq. A bad file there
    does not break the app, it breaks the HOST: dnsmasq refuses to start and
    the machine loses name resolution, mail and updates with it. So the config
    is tested first, and removed again if it fails."""
    common = (YNH / "scripts" / "_common.sh").read_text()
    assert "--test --conf-file" in common, "config is applied without validation"
    # Absolute path: /usr/sbin is not on every PATH, and a check that cannot
    # find its binary is a check that always reports failure.
    assert "/usr/sbin/dnsmasq --test" in common, "validation depends on PATH"
    i = common.index("--test --conf-file")
    assert "ynh_safe_rm" in common[i:i + 400], "invalid config is left in place"


def test_the_host_dns_change_is_reversed_on_removal():
    """Host-wide state the app borrowed has to be given back, and before the
    other teardown steps in case one of them fails."""
    remove = (YNH / "scripts" / "remove").read_text()
    assert "remove_lan_dns" in remove
    assert remove.index("remove_lan_dns") < remove.index("ynh_config_remove_nginx")


def test_lan_dns_is_only_offered_when_the_restriction_is_on():
    """It exists to make lan_only usable; on its own it would just be an app
    quietly taking over the host's DNS."""
    m = tomllib.load((YNH / "manifest.toml").open("rb"))
    assert m["install"]["lan_dns"]["visible"] == "lan_only == 1"
    c = tomllib.load((YNH / "config_panel.toml").open("rb"))
    assert c["main"]["access"]["lan_dns"]["visible"] == "lan_only == '1'"
