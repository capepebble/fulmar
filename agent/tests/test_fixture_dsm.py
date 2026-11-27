import json

from nas_agent.app_factory import FixtureDsm


async def test_fixture_dsm_picks_the_log_type_entry_first(tmp_path):
    (tmp_path / "general.json").write_text(json.dumps({"items": ["général"], "_note": "x"}))
    (tmp_path / "files.json").write_text(json.dumps({"items": ["fichiers"]}))
    (tmp_path / "index.json").write_text(
        json.dumps(
            {
                "SYNO.Core.SyslogClient.Log.list": "general.json",
                "SYNO.Core.SyslogClient.Log.list[logtype=ftp,cifs]": "files.json",
            }
        )
    )
    dsm = FixtureDsm(tmp_path)

    async def items(logtype):
        res = await dsm.call(
            "SYNO.Core.SyslogClient.Log", "list", max_version=1, params={"logtype": logtype}
        )
        return res["items"]

    assert await items("ftp,cifs") == ["fichiers"]
    assert await items("system,netbackup") == ["général"]
    assert await dsm.call("SYNO.Core.SyslogClient.Log", "list", max_version=1) == {
        "items": ["général"]
    }
