# Fulmar

Monitoring for Synology NAS that stays on your NAS. Free, open source, no account, no cloud.

Fulmar reads your NAS around the clock and tells you plainly what is fine, what is not, and what to do about it. One NAS or a whole fleet, yours or your clients'.

## What it checks

48 checks, each with a clear verdict and what to do next:

- **Backups**: Hyper Backup and Active Backup for Business tasks, failures, staleness, the 3-2-1 rule.
- **Disks and storage**: failing or worn disks, pool health and redundancy, scrubbing, snapshots, when each volume will be full.
- **Security**: Synology security advisories that affect your DSM and packages, the end of life of your model, SSH and Telnet left open, firewall, HTTPS, two-factor for administrators, certificates, failed logins and unusual file activity.
- **Vitals**: CPU, memory, temperatures, with their history kept on the NAS.

## What it does

- **A console for the whole fleet**: one page for every NAS, then each NAS in detail. The NAS where Fulmar is installed follows your other NAS too, with nothing to install on them.
- **Groups**: sort your NAS by client, site or anything else.
- **Updates**: packages and DSM, one NAS after another, with protections for what must never be updated.
- **Closes SSH or Telnet left open**, after the delay you choose.
- **A monthly report** per NAS, group or fleet, printable to PDF.
- **Alerts** by email, ntfy or webhook.
- **Cards on the table**: the Access tab of each NAS shows everything Fulmar does on it, who uses it and where it connects. Detaching a NAS takes one click.
- **An API**: REST with OpenAPI, and an MCP server for AI assistants, with scoped tokens and a hash-chained call log.

## What it never does

- **It reads.** The only changes it makes to a NAS are package and DSM updates, and closing SSH or Telnet, when you ask for them or schedule them.
- **Nothing is exposed to the Internet.** The console is published on your local network only.
- **Nothing leaves your network** except what you choose: the alerts you configure, and Synology's public security advisories, read from synology.com (this can be turned off).

## Install

You need DSM 7.2 or later and the Container Manager package.

1. **A DSM account for Fulmar**, named `fulmar`, in the administrators group. Fulmar uses it to read the NAS and nothing else.
2. **A Container Manager project**: Project, Create, paste [`deploy/compose.yaml`](deploy/compose.yaml). Or, from a clone: `docker compose -f deploy/compose.yaml up -d`.
3. **Open `http://<your NAS>:3410`**: enter the installation code printed in the console's log, choose a password, then connect DSM with the `fulmar` account.

The step-by-step guide, with HTTPS, settings and day-to-day tasks, is in [`deploy/INSTALL.md`](deploy/INSTALL.md).

## On your phone

The Fulmar app for iPhone and Android is coming soon: alerts from anywhere without a VPN, the state of each NAS, and an alert when a NAS goes silent, end-to-end encrypted. Follow [fulmar.watch](https://fulmar.watch) to know when it lands.

## Remove Fulmar

Stop and delete the `nas-agent` project in Container Manager, then delete the `fulmar` account in DSM. Nothing else stays on the NAS.

## Develop

The agent is written in Python and managed with [uv](https://docs.astral.sh/uv/); the console is a Next.js app managed with pnpm.

```bash
cd agent && uv run pytest                          # offline tests, on recorded DSM responses
cd console && pnpm install && pnpm dev --port 3410 # a demo fleet, no NAS needed
```

## License

Fulmar is free software under the GNU Affero General Public License v3.0, in [`LICENSE`](LICENSE). Contributions are welcome under a contributor license agreement.

Fulmar is published by Cape Pebble. It is an independent project, compatible with Synology NAS and not affiliated with Synology.
