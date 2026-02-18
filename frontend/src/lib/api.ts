import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  // Avoid infinite skeleton/loading when backend is blocked by long-running generation.
  timeout: 8000,
})
