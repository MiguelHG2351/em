import Shortcut from '../@types/Shortcut'
import { toggleSidebarActionCreator as toggleSidebar } from '../actions/toggleSidebar'
import SettingsIcon from '../components/icons/SettingsIcon'

const toggleSidebarShortcut: Shortcut = {
  id: 'toggleSidebar',
  label: 'Toggle Recently Edited',
  keyboard: { key: 'r', alt: true },
  // TODO: Create unique icon
  svg: SettingsIcon,
  hideFromHelp: true,
  exec: (dispatch, getState) => dispatch(toggleSidebar({ value: !getState().showSidebar })),
}

export default toggleSidebarShortcut
