// The application menu on macOS. The app's windows have no frame and no menu of their own, and
// without one set here Electron installs its default menu. On macOS that menu is always there (the
// bar at the top of the screen) and its shortcuts work everywhere in the app:
//   - View > Reload (Cmd+R) reloads the window, which drops every open tab and shell
//   - View > Toggle Developer Tools, the zoom items
//   - File > Close Window (Cmd+W), which closes the main window and with it the app
// This menu keeps what a Mac user expects to work (quit, hide, copy, paste, undo, minimize) and
// leaves those out. Cmd+W stays free for the app's own "close tab".

/**
 * @param {string} appName
 * @returns {Array<object>} a template for Menu.buildFromTemplate
 */
function macMenuTemplate(appName) {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `${appName} 정보` },
        { type: 'separator' },
        { role: 'hide', label: `${appName} 가리기` },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: `${appName} 종료` }
      ]
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' }
      ]
    },
    {
      label: '윈도우',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '확대/축소' },
        { type: 'separator' },
        { role: 'front', label: '모두 앞으로 가져오기' }
      ]
    }
  ]
}

/** Roles that must not be in the menu: each would act on the whole window from a shortcut */
const FORBIDDEN_ROLES = ['reload', 'forceReload', 'toggleDevTools', 'close', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']

module.exports = { macMenuTemplate, FORBIDDEN_ROLES }
