import {createCharacter} from './index.js';
export function example(){const actor=createCharacter({body:'feminine',height:1.68});actor.update('stand',1);return actor;}
