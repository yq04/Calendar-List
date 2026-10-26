import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  DEFAULT_THEME, TOKENS, ART_BACKDROPS, STYLE_RECIPES, FONT_PRESETS,
  normalizeTheme, mergeThemeAppearance, applyTheme, applyStyleRecipe,
} from "./src/theme.js";
import { getGanZhiYear } from "./src/lunar.js";
import { createBridge } from "./src/bridge.js";
const current = structuredClone(DEFAULT_THEME);
current.type.stretch = 125;current.type.familyUi = '"Test Private", "Microsoft YaHei", sans-serif';
current.layout.weekStart = 0;current.scale = 1.4;current.scaleMode = "fixed";
const palette = { ...structuredClone(DEFAULT_THEME), name:"色卡",color:{...DEFAULT_THEME.color,bg:"#FAF4ED"},type:{stretch:50},layout:{weekStart:1},scale:.7,shape:{blur:0,shadow:false} };
const merged = mergeThemeAppearance(current, palette);
assert.deepEqual(merged.type,current.type);assert.deepEqual(merged.layout,current.layout);
assert.equal(merged.scale,1.4);assert.equal(merged.scaleMode,"fixed");
assert.equal(merged.shape.blur,0);assert.equal(merged.shape.radius,current.shape.radius);
assert.equal(merged.id,"");assert.equal(merged.color.bg,"#FAF4ED");
merged.color.bg="#000000";assert.equal(palette.color.bg,"#FAF4ED");
assert.throws(()=>normalizeTheme({...palette,schema:"kal.theme/2"}),/版本/);
const legacy={schema:"kal.theme/1",color:{bg:"#FFFFFF",fg:"#111111",fgMuted:"#444444",accent:"#224488",fgHoliday:"#882244",todayBg:"#EEEEEE"}};
const normalized=normalizeTheme(legacy);
assert.equal(normalized.color.danger,"#882244");assert.equal(normalized.color.done,"#444444");
const props=new Map();const flags=new Map();const dataset={};
const doc={documentElement:{style:{setProperty:(key,value)=>props.set(key,value)}},body:{dataset,style:{setProperty(){}},classList:{toggle:(cls,on)=>flags.set(cls,Boolean(on))}}};
applyTheme(DEFAULT_THEME,{doc});applyTheme(legacy,{doc});
assert.equal(props.get("--kal-danger"),"136 34 68");
assert.equal(props.get("--kal-font-stretch"),"100%");
// Verify style recipes and transparent / backdrop CSS outputs
assert.equal(ART_BACKDROPS.length, 6);
assert.equal(STYLE_RECIPES.length, 6);
assert.equal(FONT_PRESETS.length, 6);
const transparentTheme = applyStyleRecipe(DEFAULT_THEME, "transparent");
applyTheme(transparentTheme, { doc });
assert.equal(transparentTheme.color.bgAlpha, 0);
assert.equal(flags.get("kal-has-backdrop"), false);
assert.match(props.get("--kal-text-shadow"), /rgba/);
const canvasTheme = applyStyleRecipe(DEFAULT_THEME, "canvas");
applyTheme(canvasTheme, { doc });
assert.equal(flags.get("kal-has-backdrop"), true);
assert.equal(flags.get("kal-backdrop-art-mode"), true);
assert.equal(dataset.backdropPreset, "aurora");
assert.equal(getGanZhiYear(2026), "丙午马年");
const commands=[];
const bridge=await createBridge({invoke:async(cmd,args)=>{commands.push({cmd,args});if(cmd==="theme_commit")return {...args.theme,id:"user-new"};return {};}});
const saved=await bridge.themeCommit(palette);await bridge.themeExportDraft(palette,"draft.json");
assert.equal(saved.id,"user-new");assert.deepEqual(commands.slice(1).map(x=>x.cmd),["theme_commit","theme_export_draft"]);
assert.equal(commands[2].args.theme,palette);
const roles=["danger","dangerFg","focus","done","selectedBg","selectedFg"];
for(const role of roles)assert.ok(TOKENS.some(t=>t.path===`color.${role}`));
// The backend owns the single source of truth for preset palettes.
const presets=["starport-paper","deep-ocean","mocha","nord","rose-dawn"];
for(const name of presets){
  const t=JSON.parse(await fs.readFile(new URL(`../src-tauri/themes/${name}.json`,import.meta.url),"utf8"));
  const preview=mergeThemeAppearance(current,t);
  assert.deepEqual(preview.type,current.type);assert.deepEqual(preview.layout,current.layout);
  for(const role of roles)assert.match(t.color[role],/^#[a-f0-9]{6}$/i);
}
console.log("themes: appearance-only merge, immutable palettes, legacy/version handling, semantic roles, style recipes, backdrop modes, commit/export IPC and five presets passed");
