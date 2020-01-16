import { action, computed, set } from '@ember/object';
import { alias, filterBy, not, notEmpty } from '@ember/object/computed';
import { isEmpty } from '@ember/utils';
import { TaskInstance, timeout } from 'ember-concurrency';
import { task } from 'ember-concurrency-decorators';

import DraftRegistration from 'ember-osf-web/models/draft-registration';
import NodeModel from 'ember-osf-web/models/node';
import SchemaBlock from 'ember-osf-web/models/schema-block';

import { getPages, PageManager, RegistrationResponse } from 'ember-osf-web/packages/registration-schema';

export default class DraftRegistrationManager {
    // Required
    draftRegistrationAndNodeTask!: TaskInstance<{draftRegistration: DraftRegistration, node: NodeModel}>;

    // Private
    currentPage!: number;
    registrationResponses!: RegistrationResponse;

    pageManagers: PageManager[] = [];

    @alias('onInput.isRunning') autoSaving!: boolean;
    @alias('initializePageManagers.isRunning') initializing!: boolean;
    @alias('draftRegistration.id') draftId!: string;
    @not('registrationResponsesIsValid') hasInvalidResponses!: boolean;
    @filterBy('pageManagers', 'isVisited', true) visitedPages!: PageManager[];
    @notEmpty('visitedPages') hasVisitedPages!: boolean;

    draftRegistration!: DraftRegistration;
    node!: NodeModel;

    @computed('pageManagers.{[],@each.pageIsValid}')
    get registrationResponsesIsValid() {
        return this.pageManagers.every(pageManager => pageManager.pageIsValid);
    }

    @computed('onInput.lastComplete')
    get lastSaveFailed() {
        return this.onInput.lastComplete ? this.onInput.lastComplete.isError : false;
    }

    @task({ on: 'init' })
    initializePageManagers = task(function *(this: DraftRegistrationManager) {
        const { draftRegistration, node } = yield this.draftRegistrationAndNodeTask;
        set(this, 'draftRegistration', draftRegistration);
        set(this, 'node', node);
        const registrationSchema = yield this.draftRegistration.registrationSchema;
        const schemaBlocks: SchemaBlock[] = yield registrationSchema.loadAll('schemaBlocks');
        const pages = getPages(schemaBlocks);
        const { registrationResponses } = this.draftRegistration;

        set(this, 'registrationResponses', registrationResponses || {});

        const pageManagers = pages.map(
            pageSchemaBlocks => new PageManager(
                pageSchemaBlocks,
                this.registrationResponses || {},
                this.node,
            ),
        );

        set(this, 'pageManagers', pageManagers);
    });

    @task({ restartable: true })
    onInput = task(function *(this: DraftRegistrationManager, currentPageManager: PageManager) {
        yield timeout(5000); // debounce
        if (currentPageManager && currentPageManager.schemaBlockGroups) {
            this.updateRegistrationResponses(currentPageManager);

            this.draftRegistration.setProperties({
                registrationResponses: this.registrationResponses,
            });

            try {
                yield this.draftRegistration.save();
            } catch (error) {
                throw error;
            }
        }
    });

    @task({ restartable: true })
    saveAllVisitedPages = task(function *(this: DraftRegistrationManager) {
        if (this.pageManagers && this.pageManagers.length) {
            this.pageManagers
                .filter(pageManager => pageManager.isVisited)
                .forEach(this.updateRegistrationResponses.bind(this));

            const { registrationResponses } = this;

            this.draftRegistration.setProperties({
                registrationResponses,
            });

            yield this.draftRegistration.save();
        }
    });

    constructor(draftRegistrationAndNodeTask: TaskInstance<{draftRegistration: DraftRegistration, node: NodeModel}>) {
        set(this, 'draftRegistrationAndNodeTask', draftRegistrationAndNodeTask);
        this.initializePageManagers.perform();
    }

    @action
    onPageChange(currentPage: number) {
        if (this.hasVisitedPages) {
            this.validateAllVisitedPages();
            this.saveAllVisitedPages.perform();
        }
        this.markCurrentPageVisited(currentPage);
    }

    @action
    markAllPagesVisited() {
        this.pageManagers.forEach(pageManager => {
            pageManager.setPageIsVisited();
        });
    }

    @action
    markCurrentPageVisited(currentPage: number) {
        const { pageManagers } = this;
        const isPageIndex = Number.isInteger(currentPage);

        if (!isEmpty(pageManagers) && isPageIndex) {
            pageManagers[currentPage].setPageIsVisited();
        }
    }

    @action
    validateAllVisitedPages() {
        this.visitedPages
            .forEach(pageManager => {
                pageManager.changeset!.validate();
            });
    }

    updateRegistrationResponses(pageManager: PageManager) {
        const { registrationResponses } = this;
        const { changeset } = pageManager;
        if (pageManager.schemaBlockGroups) {
            pageManager.schemaBlockGroups
                .mapBy('registrationResponseKey')
                .filter(Boolean)
                .forEach(registrationResponseKey => {
                    set(
                        registrationResponses,
                        registrationResponseKey,
                        changeset!.get(registrationResponseKey),
                    );
                });
        }
    }
}
