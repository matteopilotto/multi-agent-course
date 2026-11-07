/* Reusable retrieval-practice quiz.
 *
 * Markup:
 *   <div class="quiz">
 *     <div class="q">
 *       <p class="prompt">Question?</p>
 *       <button class="opt">answer</button>
 *       <button class="opt" data-ok>answer</button>
 *       <p class="why">Explanation shown after any attempt.</p>
 *     </div>
 *   </div>
 *   <p class="score" data-for="quiz-id"></p>   (optional)
 *
 * First click on a question is what counts toward the score. After a wrong
 * first click, the learner can keep trying; the explanation appears only once
 * the right answer is found, so they have to retrieve it rather than read it.
 */
(function () {
  const css = `
  .quiz { counter-reset: q; margin: 1.5rem 0; }
  .quiz .q { counter-increment: q; margin: 0 0 1.8rem; }
  .quiz .prompt { font-weight: 600; margin: 0 0 0.6rem; }
  .quiz .prompt::before { content: counter(q) ". "; color: var(--muted, #777); }
  .quiz .opt {
    display: block; width: 100%; text-align: left; cursor: pointer;
    font: inherit; font-size: 0.92rem; color: inherit;
    background: transparent; border: 1px solid var(--rule, #ddd); border-radius: 4px;
    padding: 0.45rem 0.8rem; margin: 0.35rem 0;
  }
  .quiz .opt:hover:not([disabled]) { border-color: var(--ink, #222); }
  .quiz .opt.right { border-color: var(--ok, green); background: rgba(47,107,58,.08); }
  .quiz .opt.wrong { border-color: var(--bad, #a22); background: rgba(155,42,31,.07); text-decoration: line-through; }
  .quiz .why { display: none; font-size: 0.88rem; margin: 0.6rem 0 0; padding-left: 0.8rem; border-left: 2px solid var(--ok, green); }
  .quiz .q.done .why { display: block; }
  .quiz-score { font-style: italic; color: var(--muted, #777); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  document.querySelectorAll(".quiz").forEach((quiz) => {
    const qs = [...quiz.querySelectorAll(".q")];
    let firstTryRight = 0, answered = 0;
    const score = document.createElement("p");
    score.className = "quiz-score";
    quiz.after(score);
    const render = () => {
      score.textContent = answered === qs.length
        ? `First-try score: ${firstTryRight} / ${qs.length}. Tell your tutor which ones you missed.`
        : "";
    };

    qs.forEach((q) => {
      let attempted = false;
      q.querySelectorAll(".opt").forEach((opt) => {
        opt.addEventListener("click", () => {
          if (q.classList.contains("done")) return;
          const ok = opt.hasAttribute("data-ok");
          if (!attempted) {
            attempted = true;
            answered++;
            if (ok) firstTryRight++;
          }
          if (ok) {
            opt.classList.add("right");
            q.classList.add("done");
            q.querySelectorAll(".opt").forEach((o) => (o.disabled = true));
          } else {
            opt.classList.add("wrong");
            opt.disabled = true;
          }
          render();
        });
      });
    });
  });
})();
