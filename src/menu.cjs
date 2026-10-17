'use strict';
function createMenu(e,{quit,openMain,navigate}){
 return e.Menu.buildFromTemplate([
  {label:'文件(&F)',submenu:[{label:'打开面板',click:openMain},{label:'关闭窗口',role:'close'},{type:'separator'},{label:'退出应用',accelerator:'CmdOrCtrl+Q',click:quit}]},
  {label:'编辑(&E)',submenu:[{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'}]},
  {label:'视图(&V)',submenu:[{label:'重置缩放',role:'resetZoom'},{label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{type:'separator'},{label:'全屏',role:'togglefullscreen'},{label:'开发者工具',role:'toggleDevTools'}]},
  {label:'窗口(&W)',submenu:[{label:'最小化',role:'minimize'},{label:'缩放窗口',role:'zoom'}]},
  {label:'帮助(&H)',submenu:[{label:'关于与更新',click:()=>navigate('about')}]},
 ]);
}
module.exports={createMenu};
