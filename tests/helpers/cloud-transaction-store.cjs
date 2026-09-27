// Isolated contract simulator, not a claim of real CloudBase validation.
const assert = require('node:assert/strict')
module.exports = function createStore() {
  let rows = new Map(), tail = Promise.resolve()
  const state = { transactions: 0, operations: [], beforeCommit: null }
  const clone = value => structuredClone(value)
  const key = (collection,id) => collection + '/' + id
  const collection = (name, map, count = () => {}) => ({
    doc(id) { return {
      async get() { count(); return {data:clone(map.get(key(name,id)) || null)} },
      async set({data}) { count(); map.set(key(name,id),{...clone(data),_id:id}); return {stats:{created:1}} },
      async update({data}) { count(); const previous=map.get(key(name,id)); if (!previous) return {stats:{updated:0}}; map.set(key(name,id),{...previous,...clone(data)}); return {stats:{updated:1}} },
      async remove() { count(); return {stats:{removed:map.delete(key(name,id))?1:0}} }
    } },
    where(filter) {
      let offset=0,limit=100,ordering=[]
      const selected=()=>[...rows.entries()].filter(([id,row])=>id.startsWith(name+'/') && Object.entries(filter).every(([field,value])=>value?.gt !== undefined ? row[field]>value.gt : row[field]===value))
        .map(([,row])=>row).sort((a,b)=>{for(const [field,dir] of ordering){if(a[field]!==b[field]) return (a[field]<b[field]?-1:1)*(dir==='desc'?-1:1)}return 0})
      const query={ orderBy(field,dir) {ordering.push([field,dir]);return query}, skip(value) {offset=value;return query}, limit(value) {limit=value;return query},
        async get() {return {data:clone(selected().slice(offset,offset+limit))}}, async count() {return {total:selected().length}} }
      return query
    }
  })
  const db={command:{gt:value=>({gt:value})},collection:name=>collection(name,rows),runTransaction(work){
    const result=tail.then(async()=>{const snapshot=clone(rows);let operations=0;state.transactions++
      const tx={collection:name=>{const value=collection(name,snapshot,()=>{operations++;assert.ok(operations<=100,'CloudBase transaction operation limit')});delete value.where;return value}}
      const data=await work(tx);await state.beforeCommit?.(snapshot,state.transactions);rows=snapshot;state.operations.push(operations);return data
    });tail=result.catch(()=>{});return result
  }}
  return {db,state,seed(collectionName,id,row){rows.set(key(collectionName,id),{...clone(row),_id:id})},all(name){return clone([...rows.entries()].filter(([id])=>id.startsWith(name+'/')).map(([,row])=>row))}}
}
