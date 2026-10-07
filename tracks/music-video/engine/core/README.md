# 镜头表适配层

调用 `await createEngine({canvas,shots,scenes,world,width,height,quality})`。此处只转换 JSON 镜头和场景更新契约，渲染由 [完整 core.js](../core.js) 执行。seek/resize 是异步操作，必须 await。详见 [引擎说明](../README.md)。
