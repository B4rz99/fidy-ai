(() => {
  const form = document.querySelector(".waitlist-form");
  const locale = form.getAttribute("data-locale");
  const msgSuccess = form.getAttribute("data-msg-success");
  const msgError = form.getAttribute("data-msg-error");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = form.querySelector('input[type="email"]').value.trim();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;

    fetch("/api/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, locale }),
    })
      .then((res) => {
        if (res.status === 200) {
          const success = document.createElement("p");
          success.className = "waitlist-success";
          success.textContent = msgSuccess;
          form.replaceChildren(success);
        } else {
          btn.disabled = false;
          alert(msgError);
        }
      })
      .catch(() => {
        btn.disabled = false;
        alert(msgError);
      });
  });
})();
