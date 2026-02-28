interface ImportMetaEnv {
  readonly VITE_GRAPH_FEATURE_ENABLED?: string
  readonly VITE_L4_PROFILE_ENABLED?: string
  readonly VITE_L4_AUTO_EXTRACT_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
