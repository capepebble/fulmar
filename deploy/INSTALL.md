# Install Fulmar on a Synology NAS

The engine is the agent (it reads the NAS) and the console (it shows what the agent reads), in a single Container Manager project. Nothing is exposed to the Internet: the console is read on your local network, or through the remote access you already have.

You need DSM 7.2 or later and the Container Manager package.

## 1. The agent's account in DSM

In **Control Panel > User & Group**:

1. Create an account named `fulmar`, without an email address, with this description: "Fulmar: reads this NAS, can update its packages and DSM, and close SSH. Deleting this account cuts Fulmar off." DSM shows it in the list of accounts, so anyone can see what the account is for and how to stop Fulmar. Give it a random password of at least 32 characters; you type it only once, when you connect DSM in the console (step 3).
2. Add it to the `administrators` group: storage, certificates, security settings and logs can only be read by an administrator, even through DSM's delegable privileges.
3. Give it no access to any shared folder. In **Application privileges**, deny everything DSM lets you deny: File Station, SMB, AFP, FTP, WebDAV, rsync, Drive, Photos.
4. If two-factor authentication is enforced for administrators, keep your authenticator app at hand: DSM asks for a code once, then the agent keeps a device token.

The agent reads the NAS. It changes it only to update its packages or DSM, or to close SSH or Telnet left open, when you ask for it from the console or schedule it. The account serves the agent and nothing else. The **Access** tab of each NAS shows everything Fulmar does on it, who uses it and where it connects.

## 2. The project

In Container Manager: **Project**, **Create**, name `nas-agent`, path `/volume1/docker/nas-agent`, source "Create docker-compose.yml", and paste [`compose.yaml`](compose.yaml). Or, from a clone of the repository: `docker compose -f deploy/compose.yaml up -d --build`.

Until the images are published, they are built from the repository (`--build`). The project creates two containers (`agent`, `console`), a private network and three volumes; it publishes only the console, on port 3410.

If DSM's firewall is on: open port 3410 to your local network, and DSM's HTTPS port (5001) to the project's subnet (`172.29.54.0/24` by default), through which the agent reaches DSM.

## 3. First launch

Open `http://<NAS address>:3410`.

1. **The installation code** is in the console's log (Container Manager, Project, `nas-agent`, Log; or `docker compose logs console`). It proves you administer the NAS: without it, any device on the network could claim the console before you.
2. **The console's password**, 12 characters or more.
3. **DSM**: the address is already filled in (this NAS, as seen from the project). The console shows the fingerprint of DSM's certificate; the agent will talk to that certificate only. Then the account from step 1, its password, and the two-factor code if DSM asks for one.

The fleet opens on your NAS.

## HTTPS

By default the console is read over HTTP on your local network: the password travels in clear text, as with most self-hosted tools. To read it over HTTPS with DSM's certificate: Control Panel, Login Portal, Advanced, **Reverse Proxy**, a rule from `HTTPS, <NAS name>, 3411` to `HTTP, localhost, 3410`. The console then recognizes HTTPS and sets its cookie on encrypted connections only.

## Settings

Project variables, all optional (in Container Manager: the project's environment; on the command line: an `.env` file next to `compose.yaml`):

| Variable | Default | Role |
|---|---|---|
| `CONSOLE_PORT` | `3410` | The console's port on the NAS. |
| `NAS_SUBNET` | `172.29.54.0/24` | The project's subnet; change it if it overlaps a network of your site. |
| `TZ` | `Europe/Paris` | Time zone used to display times. |
| `NAS_LANGUAGE` | `en` | Language of the agent's alerts (`en` or `fr`). The console follows the browser's language, or the one chosen at the bottom of its sidebar. |
| `NAS_VERSION` | `latest` | Version of the images. |
| `NAS_FLEET_MAX` | `50` | How many NAS this hub can follow besides its own; a guard for its memory, not a product limit. `0` turns adding off. |

## Day to day

- **Console password forgotten**: `docker compose exec console rm /data/auth/account.json`, then restart the console; a new installation code is written to its log.
- **Password of the agent's account changed in DSM**: `docker compose exec -it agent nas-agent enroll`. For a NAS added to the hub: remove it from the fleet, then add it again (its history starts over).
- **Sign out** signs out every device.
- **"Too many attempts"**: five failures per device, or twenty across all devices, within fifteen minutes. If another device on the network locks you out this way, restarting the console clears the counters; its log records the address of each failure.
- **Stop**: `docker compose down` keeps the volumes (the agent stays connected, the password stays). `docker compose down -v` erases everything: installation starts over.

Both containers restart on their own after a NAS reboot or a DSM update (`restart: always`), so a `docker stop` only lasts until Docker starts again.

## Several NAS

The NAS where the engine is installed acts as a hub: it also follows your other NAS, with nothing to install on them, even those without Container Manager.

1. On each other NAS, create the agent's account as in section 1.
2. If its firewall is on, let the hub's address reach its DSM HTTPS port (5001).
3. In the console, **Fleet**, **Add a NAS**: its address on your network, the fingerprint of its certificate to confirm, the account and its password.

The NAS joins the fleet with its verdicts, its charts and its alerts (the hub's alert channels, thresholds and language apply to all). **Remove from the fleet**, at the bottom of its Access tab, erases from the hub everything about it; nothing changes on the NAS.

Good to know: the hub keeps the password of each NAS's agent account, in a private file on its volume. Whoever takes over the hub can therefore read your other NAS with that account. That is why the account has access to no folder and no application (section 1).

## Remove Fulmar from a NAS

From DSM, without the console:

- **See it connected**: Resource Monitor > Connections shows the `fulmar` account and the address it reads from (the NAS itself for the engine, the hub for an added NAS); Log Center keeps its connections.
- **Cut it off at once**: Control Panel > User & Group, delete the `fulmar` account (or change its password). The trusted device of its two-factor authentication, if any, goes with it.
- **Remove it**: Container Manager > Project, stop then delete the `nas-agent` project (then its volumes, unless you plan to reinstall).

From the console, **Access** tab:

- **Detach this NAS** (the NAS that runs the engine): the agent revokes its tokens except the console's, cancels scheduled updates, erases the account's password, then waits for a new installation. Refused while NAS are added to the hub or an update is running. Nothing changes in DSM: then delete the account and the project as above.
- **Remove from the fleet** (a NAS added to the hub): the hub erases everything about it; then delete the `fulmar` account on that NAS.

## Remote access and AI assistants

To read the console away from your network, use the remote access you already have (a VPN, Tailscale on the NAS). Never publish port 3410 to the Internet.

The agent's REST API (OpenAPI) and its MCP server, for scripts and AI assistants, listen on the project's private network only. A guide to reach them safely from another machine is on its way.
