import { expect, it } from "vitest";
import { buildBrowserHome } from "./browserHome";
it("merges open pages, removes duplicate and non-web URLs, and retains resume work", () => {
  const result = buildBrowserHome({recent:[{url:"https://a.test",title:"A",shotKey:"shot"},{url:"https://a.test",title:"duplicate"},{url:"javascript:alert(1)",title:"bad"}],frequent:[],tasks:[{url:"https://a.test",title:"A",count:2}],missions:[{missionId:"m",title:"Research"}]},[{browseId:"a",url:"https://a.test"},{browseId:"b",url:"https://b.test",title:"B"}],12);
  expect(result.recent.map(page=>page.url)).toEqual(["https://a.test","https://b.test"]); expect(result.recent[0]).toMatchObject({browseId:"a",shotKey:"shot"}); expect(result.tasks[0].count).toBe(2); expect(result.missions[0].missionId).toBe("m");
});
it("bounds every homepage section", () => { const pages = Array.from({length:20},(_,i)=>({url:`https://host${i}.test`,title:String(i)})); const result = buildBrowserHome({recent:pages,frequent:pages,tasks:pages,missions:[]},[],4); expect(result.recent).toHaveLength(4); expect(result.frequent).toHaveLength(4); expect(result.tasks).toHaveLength(4); });
