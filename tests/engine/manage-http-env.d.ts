declare global {
  namespace Cloudflare {
    interface Env {
      OTHER_DB: D1Database
    }
    interface GlobalProps {
      mainModule: typeof import("../../adapters/http/manageWorker")
    }
  }
}
export {}
