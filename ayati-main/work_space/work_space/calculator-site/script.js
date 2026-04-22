// Basic calculator logic: supports + - * /, decimals, clear, backspace, keyboard
(function(){
  const display = document.getElementById('display');
  const keys = document.querySelector('.keys');
  let expr = '';

  function updateDisplay(){
    display.textContent = expr === '' ? '0' : expr;
  }

  function isOperator(ch){
    return ['+','-','*','/'].includes(ch);
  }

  function appendValue(v){
    if (isOperator(v)){
      if (expr === '') return; // don't start with operator except - (optional)
      // replace trailing operator
      if (isOperator(expr.slice(-1))){
        expr = expr.slice(0,-1) + v;
      } else {
        expr += v;
      }
    } else if (v === '.'){
      // prevent multiple decimals in current number
      const tokens = expr.split(/[-+*/]/);
      const last = tokens[tokens.length-1] || '';
      if (!last.includes('.')) expr += v;
    } else {
      expr += v;
    }
    updateDisplay();
  }

  function clearAll(){ expr = ''; updateDisplay(); }
  function backspace(){ expr = expr.slice(0,-1); updateDisplay(); }

  function evaluateExpr(){
    if (expr === '') return;
    // prevent trailing operator
    if (isOperator(expr.slice(-1))) expr = expr.slice(0,-1);
    try{
      // safe-ish evaluation: only digits, operators, decimal allowed
      if (!/^[0-9+\-*/.() ]+$/.test(expr)) throw new Error('Invalid chars');
      const result = Function('return ('+expr+')')();
      expr = String(result);
      updateDisplay();
    }catch(e){
      display.textContent = 'Error';
      expr = '';
    }
  }

  keys.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('button');
    if (!btn) return;
    const val = btn.getAttribute('data-value');
    const action = btn.getAttribute('data-action');
    if (action === 'clear') return clearAll();
    if (action === 'back') return backspace();
    if (action === 'equals') return evaluateExpr();
    if (val) return appendValue(val);
  });

  // Keyboard support
  window.addEventListener('keydown', (ev)=>{
    const k = ev.key;
    if ((/^[0-9]$/).test(k)) { appendValue(k); ev.preventDefault(); return; }
    if (k === 'Enter') { evaluateExpr(); ev.preventDefault(); return; }
    if (k === 'Backspace') { backspace(); ev.preventDefault(); return; }
    if (k === 'Escape') { clearAll(); ev.preventDefault(); return; }
    if (k === '.') { appendValue('.'); ev.preventDefault(); return; }
    if (['+','-','*','/'].includes(k)) { appendValue(k); ev.preventDefault(); return; }
  });

  // initialize
  updateDisplay();
})();
