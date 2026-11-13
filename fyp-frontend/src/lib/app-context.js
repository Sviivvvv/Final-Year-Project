import { createContext, useContext } from 'react';

/**
 * Shared app state handed down from Root:
 *   auth      { token, role, email }
 *   api       (path, { method, body }) -> { status, data }   (adds the bearer token, handles 401)
 *   navigate  (path) -> void
 *   toast     (message) -> void
 *   refreshHistory () -> void   re-fetch the sidebar list after a submit / review
 *   historyVersion number       bumps whenever the list should reload
 */
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
