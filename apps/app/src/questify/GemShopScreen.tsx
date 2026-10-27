import type { GemShop, MessageKey, ProfileItem, Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { usePlayer, type Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { GemIcon } from "#src/questify/GemIcon.tsx";
import { ShopCard } from "#src/questify/GemShopCards.tsx";
import { createPurchaser, fetchGemShop } from "#src/questify/gem-shop-api.ts";
import { equipFieldOf, offerNow, sectionsOf, settlePurchase } from "#src/questify/gem-shop-flow.ts";
import { gemsLabel } from "#src/questify/gems.ts";
import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import { saveProfile } from "#src/questify/profile-api.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The shop, read again on every focus; a read that fails keeps the last good one and says so. */
function useShopRead() {
  const [shop, setShop] = useState<GemShop | null>(null);
  const [failed, setFailed] = useState(false);
  const newest = useRef(0);
  const load = useCallback(async (): Promise<GemShop | null> => {
    newest.current += 1;
    const mine = newest.current;
    const next = await fetchGemShop(api.session);
    if (mine === newest.current) {
      setFailed(next === null);
      if (next !== null) setShop(next);
    }
    return next;
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  return { shop, failed, load };
}

/**
 * Getting an item: the sheet that asks, the purchase with a key for each confirmation, and what each answer does
 * (`stepAfter`). The sheet stays open on a changed price and asks again with the new one.
 */
function usePurchase(shop: GemShop | null, load: () => Promise<GemShop | null>) {
  const { reload } = usePlayer();
  const buy = useMemo(() => createPurchaser(api.session, randomUuid), []);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [bought, setBought] = useState<ProfileItem | null>(null);

  const ask = (itemId: string) => {
    setNotice(null);
    setBought(null);
    setAsking(itemId);
  };
  const confirm = async () => {
    const item = asking === null ? undefined : offerNow(shop, asking);
    if (item === undefined || busy) return;
    setBusy(true);
    const settled = await settlePurchase({
      buy: () => buy(item.id, item.price),
      load,
      reloadPlayer: () => void reload(),
      itemId: item.id,
    });
    if (settled.leave) {
      router.replace("/home");
      return;
    }
    setNotice(settled.notice);
    setBought(settled.bought);
    if (settled.closeSheet) setAsking(null);
    setBusy(false);
  };
  return { asking, busy, notice, bought, ask, confirm, close: () => setAsking(null) };
}

function Balance({ gems }: Readonly<{ gems: number }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <GemIcon size={28} />
      <AppText variant="title" accessibilityRole="header">
        {t("gemShop.balance", { gems: gemsLabel(t, gems, language, "subject") })}
      </AppText>
    </View>
  );
}

/** What happened to the last try, and when the balance was short, how gems are earned (never how to buy them). */
function Notice({ notice, price }: Readonly<{ notice: MessageKey | null; price: number | null }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (notice === null) return null;
  const params = price === null ? undefined : { gems: gemsLabel(t, price, language) };
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
      <AppText>{t(notice, params)}</AppText>
      {notice === "gemShop.tooFew" ? <AppText muted>{t("gemShop.howEarned")}</AppText> : null}
    </View>
  );
}

/** The item just got, with a way to wear it now. */
function GotCard({ item }: Readonly<{ item: ProfileItem }>) {
  const { t, language } = useI18n();
  const { reload } = usePlayer();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<"idle" | "busy" | "saved" | "failed">("idle");
  const equip = async () => {
    setState("busy");
    const answer = await saveProfile(api.session, { [equipFieldOf(item.kind)]: item.id });
    if (answer.kind === "ok") await reload();
    setState(answer.kind === "ok" ? "saved" : "failed");
  };
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <AppText>{t("gemShop.got", { name: item.name[language] })}</AppText>
      {state === "saved" ? <AppText muted>{t("locker.saved")}</AppText> : null}
      {state === "failed" ? (
        <AppText accessibilityRole="alert">{t("error.generic")}</AppText>
      ) : null}
      {state === "saved" ? null : (
        <Button
          label={t("gemShop.equipNow")}
          disabled={state === "busy"}
          onPress={() => void equip()}
        />
      )}
    </View>
  );
}

function ShopBody({ me }: Readonly<{ me: Me }>) {
  const { t, language } = useI18n();
  const { shop, failed, load } = useShopRead();
  const purchase = usePurchase(shop, load);
  const asked = purchase.asking === null ? undefined : offerNow(shop, purchase.asking);
  const sections = sectionsOf(shop?.items ?? []);
  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      {shop === null ? null : <Balance gems={shop.gems} />}
      <AppText muted>{t("gemShop.earnedByPlaying")}</AppText>
      {shop === null && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("gemShop.failed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
        </>
      ) : null}
      {purchase.bought === null ? null : (
        <GotCard key={purchase.bought.id} item={purchase.bought} />
      )}
      <Notice notice={purchase.asking === null ? purchase.notice : null} price={null} />
      {shop !== null && sections.length === 0 ? (
        <AppText muted>{t("gemShop.empty")}</AppText>
      ) : null}
      {sections.map((section) => (
        <View key={section.kind} style={{ gap: 12 }}>
          <AppText variant="title" accessibilityRole="header">
            {t(`gemShop.${section.kind}s`)}
          </AppText>
          {section.items.map((item) => (
            <ShopCard
              key={item.id}
              item={item}
              me={me}
              disabled={purchase.busy}
              onGet={() => purchase.ask(item.id)}
            />
          ))}
        </View>
      ))}
      <Sheet
        visible={asked !== undefined}
        title={
          asked === undefined
            ? ""
            : t("gemShop.confirmTitle", {
                name: asked.name[language],
                gems: gemsLabel(t, asked.price, language),
              })
        }
        onClose={purchase.close}
        closeLabel={t("common.cancel")}
      >
        <AppText>{t("gemShop.confirmBody")}</AppText>
        <Notice notice={purchase.notice} price={asked?.price ?? null} />
        <Button
          label={t(purchase.busy ? "gemShop.working" : "gemShop.get")}
          disabled={purchase.busy}
          onPress={() => void purchase.confirm()}
        />
      </Sheet>
    </ScrollView>
  );
}

/**
 * The Questify gem shop (T-404b, FR-726, ADR-289): frames and titles for gems the player earned. It says gems are
 * earned by playing and cannot be bought, and has no control that adds gems or takes the player out of the app.
 */
export function GemShopScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me : undefined;
  return (
    <Screen title={t("gemShop.title")}>
      {me === undefined ? <ProfileGate /> : <ShopBody key={me.id} me={me} />}
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.sm },
  notice: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
