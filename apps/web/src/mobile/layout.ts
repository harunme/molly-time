import { useEffect, useState } from 'react';

export function useMobileLayout() {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 1023px)').matches);
  useEffect(() => { const media = matchMedia('(max-width: 1023px)'); const change = () => setMobile(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  return mobile;
}
