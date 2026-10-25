const menu = document.querySelector('.menu');
const links = document.querySelector('.nav-links');

menu?.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});

links?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    links.classList.remove('open');
    menu?.setAttribute('aria-expanded', 'false');
  });
});

document.querySelector('#year').textContent = new Date().getFullYear();

const interfaceTabs = [...document.querySelectorAll('.interface-tabs [role="tab"]')];
function selectInterfaceTab(tab, focus = false) {
  interfaceTabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focus) tab.focus();
}
interfaceTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectInterfaceTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % interfaceTabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + interfaceTabs.length) % interfaceTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = interfaceTabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectInterfaceTab(interfaceTabs[next], true);
    }
  });
});
