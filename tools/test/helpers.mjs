import {startServer} from '../serve.mjs';
export async function localServer(root) {
  for (let port = 39920; port <= 39929; port++) {
    try { return await startServer({root, port}); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free assigned loopback port');
}
