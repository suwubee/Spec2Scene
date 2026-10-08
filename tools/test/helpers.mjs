import {startServer} from '../serve.mjs';
export async function localServer(root, {min=Number(process.env.SCENE_TEST_PORT_MIN||39920),max=Number(process.env.SCENE_TEST_PORT_MAX||39939)}={}) {
  if(!Number.isInteger(min)||!Number.isInteger(max)||min<39920||max>39939||min>max)throw new Error('Invalid assigned test port range');
  for (let port = min; port <= max; port++) {
    try { return await startServer({root, port}); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free assigned loopback port');
}
