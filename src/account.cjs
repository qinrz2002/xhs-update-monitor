'use strict';
function accountFromState(state) {
  if (state?.user?.loggedIn !== true) return null;
  const info = state.user.userInfo;
  if (!info || typeof info !== 'object') return null;
  const id = String(info.userId || info.user_id || info.id || '');
  const name = String(info.nickname || info.nickName || info.name || '').trim().slice(0, 100);
  return /^[a-f\d]{24}$/i.test(id) && name ? { id, name } : null;
}
function validAccount(value) {
  return value && /^[a-f\d]{24}$/i.test(value.id || '') && typeof value.name === 'string' && value.name.trim()
    ? { id: value.id, name: value.name.trim().slice(0, 100) } : null;
}
module.exports = { accountFromState, validAccount };
