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
