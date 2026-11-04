import type { WorkspaceApi } from './useWorkspace'

/** Placeholder until the desktop gRPC client lands. */
export function GrpcPane(_: { ws: WorkspaceApi; notify: (m: string) => void }) {
  return <section className="request"><p className="muted">gRPC requests are coming to the desktop app.</p></section>
}
