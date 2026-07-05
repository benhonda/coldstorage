/* Section — FAQ · full: all six questions (where, sync, cost, lapse, floor,
   wind-down). Question pool is CS_FAQ in shared/site-common.jsx. */

(function () {
  const { Accordion } = window.ColdstorageDesignSystem_41ebaf;

  function SectionFaqFull() {
    const items = [CS_FAQ.where, CS_FAQ.sync, CS_FAQ.cost, CS_FAQ.lapse, CS_FAQ.floor, CS_FAQ.winddown];
    return (
      <section id="faq" className="csf-band" data-screen-label="FAQ" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container csf-container--text">
          <span className="csf-eyebrow">Fair questions</span>
          <h2 className="csf-title" style={{ fontSize: "var(--text-3xl)", marginBottom: 24 }}>Asked before you had to ask</h2>
          <Reveal><Accordion items={items} defaultOpen={0} /></Reveal>
        </div>
      </section>
    );
  }

  window.SectionFaqFull = SectionFaqFull;
})();
