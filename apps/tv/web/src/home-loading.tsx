import { useEffect, useState } from 'react';

export function HomeLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, []);
  return <div className="home-loading" aria-busy="true" aria-label="正在加载媒体库">
    {[0, 1].map((row) => <section className="loading-shelf" key={row}>
      <div className="loading-heading">
        {row === 0 ? <p role="status">{slow ? '加载较慢，请稍候…' : '正在加载故事…'}</p> : <span className="loading-title" aria-hidden="true" />}
      </div>
      <div className="loading-rail" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((card) => <div className="loading-card" key={card}>
          <div className="loading-cover" />
          <div className="loading-copy"><span /><small /></div>
        </div>)}
      </div>
    </section>)}
  </div>;
}
