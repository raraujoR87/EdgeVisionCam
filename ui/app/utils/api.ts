export const getApiUrl = (path: string) => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    return `http://${hostname}:8000${path}`;
  }
  return `http://localhost:8000${path}`;
};
