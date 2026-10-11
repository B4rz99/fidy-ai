import { Effect, Option } from "effect";
import { Command } from "foldkit";
import { expect, it, vi } from "vitest";
import { Message, type Model, initialModel } from "./model";
import { offers, trialStanding } from "./testing-fixtures";
import { makeSubscriptionUpdate } from "./workspace-update";

const complete = Command.define("SubscriptionTestCompleted", {
  args: {},
  messages: [Message.Completed],
  execute: () => Effect.succeed(Message.Completed()),
});
const setup = (): Readonly<{
  update: ReturnType<typeof makeSubscriptionUpdate>;
  select: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}> => {
  const select = vi.fn(() => complete({}));
  const work = vi.fn(() => complete({}));
  const refresh = vi.fn(() => complete({}));
  return {
    update: makeSubscriptionUpdate({
      Offers: refresh,
      Standing: refresh,
      Methods: refresh,
      Select: select,
      Work: work,
    }),
    select,
    work,
    refresh,
  };
};
const ready: Model = { ...initialModel, offers: Option.some(offers), offersStatus: "Ready" };

it.each([
  { payment: { ...ready.payment, busy: true } },
  { payment: { ...ready.payment, locked: true } },
  { offersStatus: "Failed" as const },
])("refuses price and method selection while enrollment is locked", (change) => {
  const { update, select } = setup();
  const model = { ...ready, ...change };
  expect(update(model, Message.SelectedPrice({ price: offers[1].id })).model).toBe(model);
  expect(update(model, Message.SelectedMethod({ method: "nequi" })).model).toBe(model);
  expect(select).not.toHaveBeenCalled();
});

it("changes an enabled method before selection without preparing payment and clears decisions when changing an offer", () => {
  const { update, select } = setup();
  expect(update(ready, Message.SelectedMethod({ method: "card" })).model).toBe(ready);
  expect(update(ready, Message.SelectedMethod({ method: "daviplata" })).model).toBe(ready);
  const changed = update(ready, Message.SelectedMethod({ method: "nequi" })).model;
  expect(changed.payment.method).toBe("nequi");
  expect(select).not.toHaveBeenCalled();
  const selected = update(
    { ...ready, selected: Option.some(offers[0].id), endUserPolicy: true, personalData: true },
    Message.SelectedMethod({ method: "nequi" })
  ).model;
  expect(selected.endUserPolicy).toBe(false);
  expect(selected.personalData).toBe(false);
  expect(selected.payment.busy).toBe(true);
  expect(select).toHaveBeenCalledWith({ price: offers[0].id, method: "nequi" });
});

it("requires both decisions for submission, locks pending actions and always permits cancellation", () => {
  const { update, work } = setup();
  update(ready, Message.RequestedPayment({ action: "Submit" }));
  update({ ...ready, endUserPolicy: true }, Message.RequestedPayment({ action: "Submit" }));
  const consented = { ...ready, endUserPolicy: true, personalData: true };
  update(consented, Message.RequestedPayment({ action: "Submit" }));
  expect(work).toHaveBeenCalledOnce();
  const pending = { ...consented, payment: { ...ready.payment, busy: true } };
  expect(update(pending, Message.ToggledDecision({ decision: "endUserPolicy" })).model).toBe(
    pending
  );
  update(pending, Message.RequestedPayment({ action: "Refresh" }));
  expect(work).toHaveBeenCalledOnce();
  update(pending, Message.RequestedPayment({ action: "Cancel" }));
  expect(work).toHaveBeenCalledTimes(2);
});

it("retains decisions within one generation and clears them for a new authorization", () => {
  const { update } = setup();
  const decided = update(
    update(ready, Message.ToggledDecision({ decision: "endUserPolicy" })).model,
    Message.ToggledDecision({ decision: "personalData" })
  ).model;
  expect(
    update(decided, Message.ChangedPayment({ payment: { ...ready.payment, busy: true } })).model
      .personalData
  ).toBe(true);
  const next = update(
    decided,
    Message.ChangedPayment({ payment: { ...ready.payment, generation: 1 } })
  ).model;
  expect(next.personalData).toBe(false);
  expect(next.endUserPolicy).toBe(false);
});

it("deduplicates loading refreshes and installs canonical offer, standing, and availability messages", () => {
  const { update, refresh } = setup();
  expect(update(initialModel, Message.RefreshOffers()).model).toBe(initialModel);
  expect(update(initialModel, Message.RefreshStanding()).model).toBe(initialModel);
  expect(refresh).not.toHaveBeenCalled();
  const failed = update(initialModel, Message.FailedOffers({ boundary: true })).model;
  expect(update(failed, Message.RefreshOffers()).model.offersStatus).toBe("Loading");
  const standing = update(ready, Message.FailedStanding()).model;
  expect(update(standing, Message.RefreshStanding()).model.standingStatus).toBe("Loading");
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(update(initialModel, Message.LoadedOffers({ offers })).model.offersStatus).toBe("Ready");
  expect(
    update(initialModel, Message.LoadedStanding({ standing: trialStanding })).model.standingStatus
  ).toBe("Ready");
  expect(
    update(ready, Message.LoadedMethods({ methods: ["daviplata"] })).model.enabledMethods
  ).toEqual(["daviplata"]);
  expect(update(ready, Message.Completed()).model).toBe(ready);
  expect(update(ready, Message.Mounted()).model).toBe(ready);
});
