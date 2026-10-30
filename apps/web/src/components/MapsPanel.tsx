"use client";

import { MAP_LIMITS, formatNumber, type Language, type TeamMap } from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { MapEditor, type MapWrites } from "#src/components/MapEditor.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { mapName, pinnedQuestIds } from "#src/lib/maps.ts";
import { mapFailure, useMaps, type MapsProps } from "#src/lib/use-maps.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type NameEdit = Readonly<{ id: string | null; nameAr: string; nameEn: string }>;

/** The panel's writes: each runs one request and says what happened, or why not. */
function useMapWrites(props: MapsProps) {
  const { language } = props;
  const t = useTranslator(language);
  const model = useMaps(props);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run: MapWrites["run"] = async (method, suffix, body, done) => {
    setNotice(null);
    setFailure(null);
    const result = await model.write(method, suffix, body);
    if (result.ok) setNotice(done());
    else setFailure(mapFailure(result.body, language, t));
    return result.ok;
  };
  const writes: MapWrites = {
    busy: model.busy,
    failure,
    clearFailure: () => setFailure(null),
    run,
  };
  return { model, notice, failure, writes, t };
}

function NameForm({
  language,
  edit,
  busy,
  problem,
  change,
  cancel,
  save,
}: Readonly<{
  language: Language;
  edit: NameEdit;
  busy: boolean;
  problem: string | null;
  change: (edit: NameEdit) => void;
  cancel: () => void;
  save: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Section title={t(edit.id === null ? "maps.page.add" : "maps.page.rename")} level={3}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <FieldGroup layout="columns">
          <Field label={t("maps.page.nameAr")}>
            <Input
              dir="rtl"
              lang="ar"
              maxLength={MAP_LIMITS.name}
              disabled={busy}
              value={edit.nameAr}
              onChange={(event) => change({ ...edit, nameAr: event.target.value })}
            />
          </Field>
          <Field label={t("maps.page.nameEn")}>
            <Input
              dir="ltr"
              lang="en"
              maxLength={MAP_LIMITS.name}
              disabled={busy}
              value={edit.nameEn}
              onChange={(event) => change({ ...edit, nameEn: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <Toolbar align="end">
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("maps.page.save")}
          </Button>
        </Toolbar>
      </Form>
    </Section>
  );
}

type Opened = Readonly<{
  select: (id: string | null) => void;
  rename: (map: TeamMap) => void;
  remove: (map: TeamMap) => void;
}>;

function MapRows({
  language,
  maps,
  selectedId,
  busy,
  opened,
  move,
}: Readonly<{
  language: Language;
  maps: readonly TeamMap[];
  selectedId: string | null;
  busy: boolean;
  opened: Opened;
  move: (index: number, step: -1 | 1) => void;
}>) {
  const t = useTranslator(language);
  if (maps.length === 0) return <EmptyState>{t("maps.page.empty")}</EmptyState>;
  return (
    <Rows>
      {maps.map((map, index) => (
        <Row
          key={map.id}
          main={
            <>
              <strong>{mapName(map, language)}</strong>
              <Muted>
                {t("maps.page.pinCount", { count: formatNumber(map.pins.length, language) })}
              </Muted>
            </>
          }
        >
          <Button
            variant={map.id === selectedId ? "primary" : "secondary"}
            aria-pressed={map.id === selectedId}
            onClick={() => opened.select(map.id === selectedId ? null : map.id)}
          >
            {t("maps.page.pins")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => opened.rename(map)}>
            {t("maps.page.rename")}
          </Button>
          <Button variant="quiet" disabled={busy || index === 0} onClick={() => move(index, -1)}>
            {t("maps.page.moveUp")}
          </Button>
          <Button
            variant="quiet"
            disabled={busy || index === maps.length - 1}
            onClick={() => move(index, 1)}
          >
            {t("maps.page.moveDown")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => opened.remove(map)}>
            {t("maps.page.delete")}
          </Button>
        </Row>
      ))}
    </Rows>
  );
}

function MapsNotices({
  language,
  problem,
  notice,
  failure,
  loading,
}: Readonly<{
  language: Language;
  problem: string | null;
  notice: string | null;
  failure: string | null;
  loading: boolean;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      {failure === null ? null : (
        <Notice tone="danger" role="alert">
          {failure}
        </Notice>
      )}
      {loading ? <Muted role="status">{t("common.loading")}</Muted> : null}
    </>
  );
}

function RemoveDialog({
  language,
  map,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  map: TeamMap;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <ConfirmDialog
      language={language}
      title={t("maps.page.deleteTitle")}
      body={t("maps.page.deleteBody", { count: formatNumber(map.pins.length, language) })}
      confirmLabel={t("maps.page.delete")}
      noteLabel={null}
      busy={busy}
      cancel={cancel}
      confirm={confirm}
    />
  );
}

type Writes = ReturnType<typeof useMapWrites>;

/** What the panel's buttons do: save a name, move a map in the order, delete a map. */
function useMapActions(
  { writes, model, t }: Writes,
  state: Readonly<{
    selectedId: string | null;
    removing: TeamMap | null;
    setSelectedId: (id: string | null) => void;
    setNameEdit: (edit: NameEdit | null) => void;
    setRemoving: (map: TeamMap | null) => void;
  }>,
) {
  const saveName = (edit: NameEdit) => {
    const body = { nameAr: edit.nameAr, nameEn: edit.nameEn };
    const path = edit.id === null ? "" : `/${edit.id}`;
    void writes
      .run(edit.id === null ? "POST" : "PUT", path, body, () => t("maps.page.saved"))
      .then((ok) => {
        if (ok) state.setNameEdit(null);
      });
  };
  const move = (index: number, step: -1 | 1) => {
    const ids = (model.maps ?? []).map((map) => map.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + step, 0, moved);
    void writes.run("PUT", "/order", { ids }, () => t("maps.page.saved"));
  };
  const remove = () => {
    const gone = state.removing;
    if (gone === null) return;
    void writes
      .run("DELETE", `/${gone.id}`, undefined, () => t("maps.page.deleted"))
      .then(() => {
        if (state.selectedId === gone.id) state.setSelectedId(null);
        state.setRemoving(null);
      });
  };
  return { saveName, move, remove };
}

type PanelState = Readonly<{
  nameEdit: NameEdit | null;
  selectedId: string | null;
  setNameEdit: (edit: NameEdit | null) => void;
  setSelectedId: (id: string | null) => void;
  setRemoving: (map: TeamMap | null) => void;
}>;

/** The name form, the list of maps and the editor of the one picked. */
function MapsContent({
  language,
  all,
  maps,
  state,
  actions,
}: Readonly<{
  language: Language;
  all: Writes;
  maps: readonly TeamMap[];
  state: PanelState;
  actions: ReturnType<typeof useMapActions>;
}>) {
  const { model, failure, writes } = all;
  const { nameEdit, selectedId } = state;
  const selected = maps.find((map) => map.id === selectedId) ?? null;
  return (
    <>
      {nameEdit === null ? null : (
        <NameForm
          key={nameEdit.id ?? "new"}
          language={language}
          edit={nameEdit}
          busy={model.busy}
          problem={failure}
          change={state.setNameEdit}
          cancel={() => {
            state.setNameEdit(null);
            writes.clearFailure();
          }}
          save={() => actions.saveName(nameEdit)}
        />
      )}
      <MapRows
        language={language}
        maps={maps}
        selectedId={selectedId}
        busy={model.busy}
        move={actions.move}
        opened={{
          select: state.setSelectedId,
          rename: (map) =>
            state.setNameEdit({ id: map.id, nameAr: map.nameAr ?? "", nameEn: map.nameEn ?? "" }),
          remove: state.setRemoving,
        }}
      />
      {selected === null ? null : (
        <MapEditor
          key={selected.id}
          language={language}
          map={selected}
          quests={model.quests}
          pinnedQuestIds={pinnedQuestIds(maps)}
          writes={writes}
        />
      )}
    </>
  );
}

export function MapsPanel(props: MapsProps) {
  const { language } = props;
  const all = useMapWrites(props);
  const { model, notice, failure, t } = all;
  const [nameEdit, setNameEdit] = useState<NameEdit | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMap | null>(null);
  const maps = model.maps;
  const state = { nameEdit, selectedId, setNameEdit, setSelectedId, setRemoving };
  const actions = useMapActions(all, { removing, ...state });
  return (
    <>
      <Stack as="section" aria-labelledby="maps-title">
        <PageHeader
          titleId="maps-title"
          title={t("maps.page.title")}
          info={infoTip(t, "maps.page.intro")}
          actions={
            <Button
              variant="primary"
              disabled={maps === null || model.busy}
              onClick={() => setNameEdit({ id: null, nameAr: "", nameEn: "" })}
            >
              {t("maps.page.add")}
            </Button>
          }
        />
        <MapsNotices
          language={language}
          problem={model.problem}
          notice={notice}
          failure={nameEdit !== null || selectedId !== null ? null : failure}
          loading={maps === null}
        />
        {maps === null ? null : (
          <MapsContent language={language} all={all} maps={maps} state={state} actions={actions} />
        )}
      </Stack>
      {removing === null ? null : (
        <RemoveDialog
          language={language}
          map={removing}
          busy={model.busy}
          cancel={() => setRemoving(null)}
          confirm={actions.remove}
        />
      )}
    </>
  );
}
