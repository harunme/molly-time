import { createClientDiagnostics } from '../../shared/client-diagnostics';

export const diagnostics = createClientDiagnostics('web-parent');

export function bindDiagnostics(userID: string, csrf: string) {
  diagnostics.bind(userID, async (body, signal) => {
    const response = await fetch('/api/client/error-logs', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
    });
    if (response.ok) return 'ack';
    return [400, 409, 413, 422].includes(response.status) ? 'drop' : 'retry';
  });
}
