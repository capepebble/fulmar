"""Services de fichiers et d'administration : ce qui écoute, et ce qui passe en clair.

Jamais la communauté SNMP ni un compte : seulement si elle est réglée (conception
2026-11-26-meilleur-produit, section 3.5).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import as_bool, as_int, as_map, as_str

# Versions qu'emploie le Panneau de configuration de DSM 7.4 ; chaque service peut manquer.
SMB = DsmCall("SYNO.Core.FileServ.SMB", "get", 3, optional=True)
AFP = DsmCall("SYNO.Core.FileServ.AFP", "get", 2, optional=True)
NFS = DsmCall("SYNO.Core.FileServ.NFS", "get", 3, optional=True)
FTP = DsmCall("SYNO.Core.FileServ.FTP", "get", 3, optional=True)
SFTP = DsmCall("SYNO.Core.FileServ.FTP.SFTP", "get", 1, optional=True)
RSYNC = DsmCall("SYNO.Backup.Service.NetworkBackup", "get", 1, optional=True)
SNMP = DsmCall("SYNO.Core.SNMP", "get", 1, optional=True)
WEB_DSM = DsmCall("SYNO.Core.Web.DSM", "get", 2, optional=True)

VERIFIED = "DS420+, DSM 7.4.1-90080 Update 2 (NAS d'essai, 2026-11-26)"
# smb.conf du NAS d'essai : smb_min_protocol 1 donne « min protocol=SMB2 ».
_SMB_LEVELS = {0: "SMB1", 1: "SMB2", 2: "SMB2_LARGE_MTU", 3: "SMB3"}


class Smb(BaseModel):
    enabled: bool | None
    min_protocol: str | None = Field(description='"SMB1", "SMB2", "SMB2_LARGE_MTU" or "SMB3".')
    max_protocol: str | None
    ntlmv1: bool | None = Field(description="NTLMv1 authentication accepted (weak).")


class Ftp(BaseModel):
    enabled: bool | None = Field(description="Plain FTP service.")
    ftps_enabled: bool | None = Field(description="FTP over TLS.")
    port: int | None


class Sftp(BaseModel):
    enabled: bool | None
    port: int | None


class Rsync(BaseModel):
    enabled: bool | None = Field(description="rsync server (network backup destination).")
    rsync_accounts: bool | None = Field(
        description="rsync accounts on: daemon mode, whose traffic is not encrypted."
    )


class Snmp(BaseModel):
    enabled: bool | None
    v1v2c: bool | None = Field(description="SNMP v1/v2c: community sent in clear text.")
    v3: bool | None
    community_set: bool | None = Field(description="A community is set; its value is never read.")


class WebDsm(BaseModel):
    http_port: int | None
    https_port: int | None
    https_redirect: bool | None = Field(description="HTTP connections redirected to HTTPS.")
    hsts: bool | None


class Services(BaseModel):
    smb: Smb | None
    afp_enabled: bool | None
    nfs_enabled: bool | None
    ftp: Ftp | None
    sftp: Sftp | None
    rsync: Rsync | None
    snmp: Snmp | None
    web: WebDsm | None


def _services(_ctx: OpContext, responses) -> Services:
    def get(call: DsmCall):
        value = responses.get(call.key)
        return None if value is None else as_map(value)

    smb, ftp, sftp, rsync, snmp, web = (get(c) for c in (SMB, FTP, SFTP, RSYNC, SNMP, WEB_DSM))
    afp, nfs = get(AFP), get(NFS)
    return Services(
        smb=None
        if smb is None
        else Smb(
            enabled=as_bool(smb.get("enable_samba")),
            min_protocol=_SMB_LEVELS.get(as_int(smb.get("smb_min_protocol"))),
            max_protocol=_SMB_LEVELS.get(as_int(smb.get("smb_max_protocol"))),
            ntlmv1=as_bool(smb.get("enable_ntlmv1_auth")),
        ),
        afp_enabled=None if afp is None else as_bool(afp.get("enable_afp")),
        nfs_enabled=None if nfs is None else as_bool(nfs.get("enable_nfs")),
        ftp=None
        if ftp is None
        else Ftp(
            enabled=as_bool(ftp.get("enable_ftp")),
            ftps_enabled=as_bool(ftp.get("enable_ftps")),
            port=as_int(ftp.get("portnum")),
        ),
        sftp=None
        if sftp is None
        else Sftp(enabled=as_bool(sftp.get("enable")), port=as_int(sftp.get("portnum"))),
        rsync=None
        if rsync is None
        else Rsync(
            enabled=as_bool(rsync.get("enable")),
            rsync_accounts=as_bool(rsync.get("enable_rsync_account")),
        ),
        snmp=None
        if snmp is None
        else Snmp(
            enabled=as_bool(snmp.get("enable_snmp")),
            v1v2c=as_bool(snmp.get("enable_snmp_v1v2")),
            v3=as_bool(snmp.get("enable_snmp_v3")),
            community_set=None
            if "rocommunity" not in snmp
            else bool(as_str(snmp.get("rocommunity"))),
        ),
        web=None
        if web is None
        else WebDsm(
            http_port=as_int(web.get("http_port")),
            https_port=as_int(web.get("https_port")),
            https_redirect=as_bool(web.get("enable_https_redirect")),
            hsts=as_bool(web.get("enable_hsts")),
        ),
    )


OPERATIONS = [
    Operation(
        id="services.list",
        title="File and administration services",
        description="SMB (minimum protocol, NTLMv1), AFP, NFS, FTP and FTPS, SFTP, rsync server, "
        "SNMP (versions; whether a community is set, never its value), DSM on the web (ports, "
        "HTTPS redirect, HSTS). A service that cannot be read is null.",
        kind="read",
        scope="security:read",
        path="/services",
        result_model=Services,
        transform=_services,
        calls=(SMB, AFP, NFS, FTP, SFTP, RSYNC, SNMP, WEB_DSM),
        cache_ttl=300,
        verified_on=VERIFIED,
    ),
]
