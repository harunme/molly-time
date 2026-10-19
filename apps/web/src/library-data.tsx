import { createContext, useContext, useState } from 'react';
import { Outlet } from 'react-router';
import type { Resource } from './api';
import type { PagedDataCache } from './pagination';

const LibraryDataContext = createContext<PagedDataCache<Resource> | undefined>(undefined);

// Keep lists while navigating folders; leaving the library or signing out discards them.
export function LibraryDataProvider() {
  const [cache] = useState<PagedDataCache<Resource>>(() => ({ pages: new Map(), positions: new Map() }));
  return <LibraryDataContext.Provider value={cache}><Outlet /></LibraryDataContext.Provider>;
}

export const useLibraryData = () => useContext(LibraryDataContext);
