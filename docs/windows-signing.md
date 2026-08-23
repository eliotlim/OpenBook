# Windows Authenticode signing

This runbook provisions Microsoft Azure Trusted Signing and enables
Authenticode signing for OpenBook's Windows release installers. Microsoft now
calls the service **Artifact Signing** in its portal and documentation; older
resources and role assignments may still say **Trusted Signing**.

OpenBook's Windows release leg builds these files on `windows-latest` and
publishes them to GitHub Releases:

- `OpenBook_<ver>_x64_en-US.msi`
- `OpenBook_<ver>_x64-setup.exe`

Follow this runbook as the Azure subscription and GitHub repository owner. Start
the Azure identity-validation work well before the release that should first be
signed.

## Why sign the Windows installers?

Authenticode gives Windows a cryptographic check that an installer has not
changed since OpenBook's validated publisher signed it. It also lets Windows
show the verified publisher name instead of **Unknown publisher** and gives
Microsoft Defender SmartScreen a stable publisher signal across releases.

Signing does **not** prove that the software is safe, prevent every warning, or
immediately suppress SmartScreen's **Windows protected your PC** prompt. A newly
signed publisher and new file hashes can still be unrecognized while reputation
accrues from clean downloads and use. Microsoft does not publish a threshold or
timeline. Sign every release consistently; unsigned releases cannot carry the
publisher signal forward.

Artifact Signing issues a new signing certificate daily, and each certificate
is valid for only 72 hours. The service places a durable, identity-specific EKU
in those certificates, so consumers can associate the changing short-lived
certificates with the same validated identity. Do not pin an individual
certificate thumbprint or public key.

> **Different signature systems:** Authenticode signs the Windows `.msi` and
> `.exe` so Windows can verify their publisher and integrity. The neighboring
> `.sig` files are Tauri updater/minisign signatures used by installed OpenBook
> clients to authenticate updates. They neither Authenticode-sign the installer
> nor affect SmartScreen. See [Release updates & updater signing](release-updates.md).

## One-time Azure setup

### 1. Create the account

1. In the intended Microsoft Entra tenant, select or create an Azure
   subscription whose billing account type and legal details match the identity
   that will be validated.
2. Register the `Microsoft.CodeSigning` resource provider on the subscription.
3. In the Azure portal, open **Artifact Signing Accounts** (formerly **Trusted
   Signing Accounts**) and create an account:
   - Subscription: `<subscription>`
   - Resource group: `<resource-group>`
   - Account name: `<signing-account>`
   - Region: **East US** (or another currently supported region)
   - Pricing tier: **Basic**

Basic currently costs US$9.99 per account per month, includes 5,000 signatures
per month, and allows one profile of each supported type; excess signatures are
US$0.005 each. Confirm the [current pricing](https://azure.microsoft.com/en-us/products/artifact-signing/)
before purchase.

The endpoint must match the account's region. For East US it is:

```text
https://eus.codesigning.azure.net
```

Do not derive or guess it. Copy it from the account overview or Microsoft's
[current region table](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#azure-regions-that-support-artifact-signing).

### 2. Validate the publisher identity

On the account, assign the owner/operator the **Artifact Signing Identity
Verifier** role, then create a **Public** identity validation in the portal.
Choose the identity type deliberately:

- **Organization** validates a legal entity. The Azure billing account must be
  an organization account, and public company/domain records should exactly
  match the submitted legal name and address.
- **Individual** validates a person and requires an individual billing account.
  Public Trust validation for individuals is currently limited to developers in
  the United States and Canada; organization availability covers additional
  countries, including Singapore.

Review the certificate-subject preview carefully: it determines the publisher
users will see. Use `<expected-publisher>` as the recorded expected value in the
verification steps below.

Microsoft says validation normally takes **1–20 business days**, and it can take
longer when more evidence is required. Watch the primary email address and the
portal for **Action Required** requests. Documents generally must have been
issued within the preceding 12 months and, when they expire, remain valid for at
least two more months. Incorrect submitted details require a new request, so
start early.

### 3. Create a Public Trust certificate profile

After identity validation reaches **Completed**, create a certificate profile:

- Profile type: **Public Trust** (not Public Trust Test or Private Trust)
- Profile name: `<signing-profile>`
- Verified identity: the completed identity above
- Program type: **None**, unless OpenBook later joins a listed Microsoft program

Record the exact account name, profile name, and regional endpoint; GitHub uses
all three verbatim.

Microsoft's [setup quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
covers the account, identity, and profile portal flows in detail.

## Give CI permission to sign

Use a dedicated Microsoft Entra application rather than an owner's user account:

1. In **Microsoft Entra ID → App registrations**, create an app named
   `<openbook-release-signing-app>`. Registration automatically creates its
   service principal.
2. Copy the **Directory (tenant) ID** and **Application (client) ID**.
3. On the signing account's **Access control (IAM)** page, grant that service
   principal **Artifact Signing Certificate Profile Signer**. The legacy label
   is **Trusted Signing Certificate Profile Signer**. Scope the assignment to
   the specific certificate profile where possible; Microsoft's
   [role-assignment guide](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
   includes the profile-scoped Azure CLI form. Also grant **Reader** on the
   signing resource group — `az login` requires the principal to see at least
   one subscription.
4. Under the app registration's **Certificates & secrets**, create a client
   secret. Copy its **Value** immediately (not its secret ID), record its expiry
   in the team's credential calendar, and store it in the password manager.

The signer role permits signing and viewing signing history; it does not grant
identity-validation or general account-management rights. Azure RBAC changes can
take several minutes to propagate.

This runbook uses a client secret because that is the current workflow contract.
A future hardening change should replace the long-lived secret with GitHub
Actions OpenID Connect workload identity federation. That requires a coordinated
workflow change (including GitHub `id-token: write`) and is not a drop-in secret
replacement.

## Wire the `publish` GitHub environment

Open **GitHub repository → Settings → Environments → `publish`**. Add these
environment secrets:

| Secret | Exact value |
| --- | --- |
| `AZURE_TENANT_ID` | Microsoft Entra Directory (tenant) ID |
| `AZURE_CLIENT_ID` | App registration Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client-secret **Value** |

Add these environment variables (not secrets):

| Variable | Exact value |
| --- | --- |
| `AZURE_SIGNING_ENDPOINT` | Regional endpoint, for example `https://eus.codesigning.azure.net` for East US |
| `AZURE_SIGNING_ACCOUNT` | `<signing-account>` |
| `AZURE_SIGNING_PROFILE` | `<signing-profile>` |

Names are case-sensitive. Keep all six values on the **`publish` environment**,
not only at repository or organization scope, because the release job reads that
environment.

The integration path is `packages/app/src-tauri/tauri.conf.json`
`bundle.windows.signCommand` → `packages/app/scripts/win-sign.mjs` → the
`windows-latest` leg in `.github/workflows/release.yml`.

After the Azure ceremony is complete, add the repository or `publish`
environment variable `WINDOWS_SIGNING_REQUIRED` with the exact value `1`. This
makes absent signing configuration a hard error; partial configuration is always
a hard error, even before enforcement is enabled.

The WSIGN-1 workflow integration is intentionally transitional:

- If any of the six values is absent, the preflight refuses partial
  configuration. When all six are absent and `WINDOWS_SIGNING_REQUIRED` is not
  `1`, the Windows leg completes an unsigned build and emits a loud GitHub
  Actions warning annotation. This permits release continuity while Azure
  validation is pending.
- When the secrets are present, signing is enforced. A signing error fails the
  Windows leg, and a post-build `signtool verify /pa` gate prevents unsigned or
  invalid Windows installers from being uploaded.

Treat the warning state as temporary. Do not partially configure the values; if
signing is meant to be active, provide every secret and variable together.

## Verify a signed build

For the first signed release, download both Windows artifacts from the GitHub
Release onto a clean Windows machine. Verify the exact downloaded files, not
copies from a build directory:

```powershell
signtool verify /pa /v .\OpenBook_<ver>_x64_en-US.msi
signtool verify /pa /v .\OpenBook_<ver>_x64-setup.exe
```

`/pa` uses the default Authenticode verification policy and `/v` prints the
certificate chain, digest, and timestamp details. Each command must exit zero
and report that the file was successfully verified. Confirm all of the
following:

- the signer subject/publisher is exactly `<expected-publisher>`;
- the chain terminates at a trusted Microsoft root;
- the file digest and signature algorithm are SHA-256;
- a timestamp countersignature is present and valid.

As an independent UI check, right-click each file in Explorer, select
**Properties → Digital Signatures**, select the signature, and open **Details**.
It should say the digital signature is OK and display
`<expected-publisher>`. The Windows consent dialog should also show that
publisher rather than **Unknown publisher**.

Repeat this release-asset check after credential rotation, profile replacement,
or signing workflow changes. A `.sig` asset beside an installer is not evidence
of Authenticode signing.

If a Windows leg fails after the release job creates the tagged GitHub release,
that release will be missing its Windows assets. Fix the credentials, then run
`gh run rerun <run-id> --failed`. The upload step uses `--clobber`, so the
re-run legs attach cleanly to the existing release.

## Rotation, expiry, and revocation

### Rotate the CI client secret

Rotate before its Entra expiry:

1. Create a second secret on the same app registration.
2. Update `AZURE_CLIENT_SECRET` in GitHub's `publish` environment with the new
   secret **Value**.
3. Run or observe a Windows release build and confirm both `signtool` gates pass.
4. Delete the old Entra secret only after that successful proof.

Tenant ID, client ID, endpoint, account, profile, and RBAC assignment stay the
same. If the client secret expires first, authentication fails and enforced
signing stops the Windows release leg.

### Renew identity validation

The portal shows the validation expiry and emails reminders; renewal opens 60
days before expiry. If validation lapses, the service stops renewing certificates
for linked profiles and signing halts. Renew in the portal. Microsoft's current
[renewal procedure](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-renew-identity-validation)
may require deleting and recreating the certificate profile with the same name
after renewal; keeping the name preserves the GitHub configuration.

### Revoke after suspected misuse

Disable or delete the compromised Entra credential immediately, then inspect the
certificate-profile signing history. Artifact Signing can revoke a selected
short-lived certificate, limiting impact to code signed with that certificate,
or revoke a profile from the portal for a broader incident. Revocation does not
repair already distributed files: remove affected GitHub Release assets, rotate
CI credentials, create a replacement profile if directed, and publish a clean
higher-version release. Follow Microsoft's
[certificate revocation procedure](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-cert-revocation)
and contact Azure Support if the portal action fails.

## SmartScreen expectations

Immediately after the first signed release, expect Windows to show the verified
publisher but still possibly warn that the app is unrecognized. That does not by
itself mean Authenticode failed; use `signtool` to distinguish a valid signature
from a reputation warning.

As clean downloads and executions accumulate, SmartScreen can learn both file
hash and publisher reputation. Consistent signing lets later releases benefit
from the stable publisher identity, but every new file also has a new hash and
there is no guaranteed warning-free date. Do not buy or change certificate types
solely for an instant bypass: Microsoft says EV certificates no longer receive
automatic positive reputation. See Microsoft's current
[SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

## Troubleshooting

### `ERROR: No subscriptions found for <tenant/app>.` during "Build Tauri bundles"

`az login --service-principal` authenticated, but the service principal cannot
see any subscription. `trusted-signing-cli` 0.9.0 invokes `az login` without
`--allow-no-subscriptions`, so the principal needs subscription visibility in
addition to the **Trusted Signing Certificate Profile Signer** role. Assign the
service principal the built-in **Reader** role on the resource group containing
the Trusted Signing account. Subscription scope also works, but is broader than
needed. The assignment takes effect within minutes; re-run the failed release
legs afterwards.

### HTTP 403 or `Forbidden`

- Confirm the workflow is using the intended tenant and client IDs.
- In the signing account's IAM page, find the **service principal** (not merely
  the app-registration object) and confirm **Artifact Signing Certificate
  Profile Signer** / **Trusted Signing Certificate Profile Signer** is assigned.
- Confirm the assignment covers the selected certificate profile, and wait a
  few minutes for a new RBAC assignment to propagate.
- Confirm `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE` exactly match the
  Azure resource names, including case.

### Endpoint, region, or account-not-found errors

`AZURE_SIGNING_ENDPOINT` must be the endpoint for the region that contains
`AZURE_SIGNING_ACCOUNT`. For East US use
`https://eus.codesigning.azure.net`; do not use a generic Azure management URL
or an endpoint copied from an account in another region. Recopy all three public
values from the same account/profile.

### Authentication failures

Confirm the GitHub values are environment secrets on `publish`, the client
secret is its **Value** rather than its ID, and it has not expired. Create a new
secret and rotate it using the overlap procedure above; do not print credentials
in Actions logs.

### `AZURE_CLI_PATH` or `az.cmd` not found

`trusted-signing-cli` has a hardcoded Azure CLI default that may point to
`az.cmd` somewhere other than the runner's installation. Set `AZURE_CLI_PATH`
to the full path of the working `az.cmd`; this is a local tool-resolution error,
not evidence that the tenant, account, or profile values are wrong.

### `SIGNTOOL_PATH` or Windows SDK version not found

`trusted-signing-cli` also has a hardcoded Windows SDK-version default for
`signtool.exe`. Set `SIGNTOOL_PATH` to the full path of an installed x64
`signtool.exe`. The release workflow resolves and exports this path explicitly;
if this appears there, inspect the runner image/tool-discovery step before
changing Azure configuration.

### Timestamp server unreachable

Artifact Signing relies on a trusted timestamp so a signature remains verifiable
after its 72-hour signing certificate expires. Treat timestamp failure as a
release failure; do not retry without timestamping or upload the unsigned files.
Check the Actions incident for transient Azure/network failure and retry the
failed Windows job. If failures persist, verify outbound HTTPS access and Azure
service health, then escalate through Azure Support. Never modify an installer
after signing, because that invalidates its signature.

### `signtool verify` fails after CI succeeded

Ensure the downloaded asset is byte-for-byte the GitHub Release asset and was
not repackaged or modified. Verify both the MSI and NSIS installer separately.
Use `/v` output to identify a digest mismatch, missing timestamp, untrusted
chain, or revoked certificate, and quarantine the release until resolved.
