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
