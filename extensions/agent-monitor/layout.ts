import { HStack, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";

/** Pi 1.2 exposes setLayoutRoot but not its getter. Read the existing root only
 * after structural checks, restore it on teardown, and fall back on any mismatch. */
export type SidebarCleanup = (()=>void)&{active:()=>boolean};
export function installSidebar(tui: TUI, sidebar: Component, wide: (width:number,height:number)=>boolean): SidebarCleanup | undefined {
	if(!isViewportTUI(tui))return;
	const viewport=tui as typeof tui & {layoutRoot?:Component};
	const original=viewport.layoutRoot;
	if(!original || typeof original.render!=="function")return;
	const split=new HStack([
		{component:original,basis:0,grow:2,shrink:1,minSize:0},
		{component:sidebar,basis:0,grow:1,shrink:1,minSize:40,visible:size=>wide(size.width,size.height)},
	],{gap:1});
	tui.setLayoutRoot(split);
	const cleanup=()=>{if(viewport.layoutRoot===split)tui.setLayoutRoot(original);};
	cleanup.active=()=>viewport.layoutRoot===split;
	return cleanup;
}
