// An expected failure of a cluster operation (bad address, expired code, peer
// not found), reported to the administrator with its own status code.
export class ClusterError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ClusterError';
  }
}
