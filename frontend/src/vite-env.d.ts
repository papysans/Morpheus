interface ImportMetaEnv {
  readonly VITE_GRAPH_FEATURE_ENABLED?: string
  readonly VITE_L4_PROFILE_ENABLED?: string
  readonly VITE_L4_AUTO_EXTRACT_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'fs' {
  export function readFileSync(path: string, encoding: string): string
}

declare module 'path' {
  export function resolve(...paths: string[]): string
}

declare const __dirname: string
