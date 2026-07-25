/** @type {import('next').NextConfig} */

// STAB-7 (LAN-hosted web UI): the SAME web app ships two ways.
//   • Default (unset): the SSR build for app.book.pub / a forwarded *.book.cloud
//     site — keeps `getServerSideProps` (reads the edge's x-openbook-prefix header)
//     and Next's server runtime.
//   • `NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1`: a CLIENT-ONLY static export (`out/`)
//     the sidecar serves on the LAN. The client talks to the sidecar's same-origin
//     `/api` (see `useWebClient`), so no Next server is needed — `output: 'export'`
//     emits a plain static bundle the sidecar's `mountUi` serves. gSSP is dropped
//     in this mode (it can't run in an export); the forwarded-prefix path is
//     irrelevant on the LAN (no edge in front).
const sameOrigin = process.env.NEXT_PUBLIC_OPENBOOK_SAMEORIGIN === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(sameOrigin
    ? {
        output: 'export',
        // No Next image optimizer in a static export (there's no server to run it).
        images: {unoptimized: true},
      }
    : {}),
};

module.exports = nextConfig;
