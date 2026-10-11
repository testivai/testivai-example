// Dynamic content on purpose: ignored via ignoreSelectors in .testivai/config.json
const tick = () => (document.getElementById('clock').textContent = new Date().toISOString());
tick();
setInterval(tick, 1000);
