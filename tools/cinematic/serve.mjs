// Author: suwubee
import {startServer as serve} from '../serve.mjs';
export function startServer({root=process.cwd(),port=39920,handler}={}) {
  if(!Number.isInteger(port)||port<39920||port>39929)throw new Error('assigned render ports: 39920–39929');
  return serve({root,port,host:'127.0.0.1',handler});
}
