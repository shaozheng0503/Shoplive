export function getSavedLang(defaultLang = 'zh') {
  return localStorage.getItem('shoplive.lang') || defaultLang;
}

export function setSavedLang(lang) {
  localStorage.setItem('shoplive.lang', lang);
}
