const API_URL = process.env.API_URL ?? 'http://localhost:8000'
export const login = () => fetch(`${API_URL}/v1/auth/login`)
