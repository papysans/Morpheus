import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  // Default timeout for normal CRUD operations.
  timeout: 15000,
})

/** Longer timeout for LLM-dependent endpoints (plan generation, review, etc.) */
export const LLM_TIMEOUT = 120_000
