// The Durable Object classes that the Sunday Workspace code made on this Worker during one deploy on 2026-11-17.
// Cloudflare refuses a version that drops a class with a namespace, unless a "deleted" entry retires it, and that deletes
// its stored data. The SheetRoom namespace holds one object with stored data. So these empty classes keep each namespace
// and its data. Agent Pages does not bind or call them. Remove them only when the data is no longer needed.
export class PageRoom {}
export class SheetRoom {}
export class ConnectionDO {}
export class DatasetDO {}
