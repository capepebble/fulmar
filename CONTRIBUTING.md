# Contributing to Fulmar

Thank you for your interest in Fulmar.

## Issues

Bug reports and ideas are welcome in the issues. Please never paste anything that identifies a NAS: its name, serial number, addresses, accounts, or raw DSM responses. Describe the model, the DSM version and what you saw instead.

## Pull requests

Fulmar accepts contributions under a contributor license agreement (CLA), signed once through a bot on your first pull request. The agreement is being set up: until it is in place, please open an issue first rather than a pull request, so that no work of yours is left waiting.

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Developing

See the "Develop" section of the [README](README.md). Every change to a DSM call goes through the agent's catalog (`agent/src/nas_agent/catalog/`), with a result model and a test on a recorded, scrubbed response.
