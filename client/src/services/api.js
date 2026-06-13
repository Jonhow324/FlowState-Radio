import axios from 'axios';

const api = axios.create({
  baseURL: '',
  timeout: 60000,  // 60s — brain + NCM resolution can be slow
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[API Error]', error.response?.status, error.message);
    return Promise.reject(error);
  }
);

export default api;
