const screens = [...document.querySelectorAll('main > section')]
const navigation = [...document.querySelectorAll('nav [data-screen]')]

function openScreen(screenId) {
  const target = screens.find((screen) => screen.id === screenId)
  if (!target || !target.hidden) return

  for (const screen of screens) screen.hidden = screen !== target

  for (const button of navigation) {
    if (button.dataset.screen === screenId) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }

  window.scrollTo(0, 0)
  target.querySelector('h1').focus({ preventScroll: true })
  document.dispatchEvent(new CustomEvent('screen-changed', { detail: screenId }))
}

for (const button of document.querySelectorAll('button[data-screen]')) {
  button.addEventListener('click', () => openScreen(button.dataset.screen))
}
