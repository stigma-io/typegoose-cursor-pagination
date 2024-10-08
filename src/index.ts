import {Model, PipelineStage, PopulateOptions, QueryOptions, Schema} from 'mongoose';
import {generateAggregatePipeline, generateCursorQuery, generateSort} from './query';
import {prepareResponse} from './response';
import {IPaginateOptions, IPaginateResult, VerboseMode} from './types';

export interface IPluginOptions {
  dontReturnTotalDocs?: boolean;
  dontAllowUnlimitedResults?: boolean;
  defaultLimit?: number;
}

/**
 * A mongoose plugin to perform paginated find() requests.
 * @param schema the schema for the plugin
 */
export default function(schema: Schema, pluginOptions?: IPluginOptions) {

  function createFindPromise<T>(mongoObject: any, options: IPaginateOptions, _query?: Object, _projection?: Object, _options?: QueryOptions<T> | null | undefined) {
    // Determine sort
    const sort = generateSort(options);

    // Determine limit
    const defaultLimit = (pluginOptions && pluginOptions.defaultLimit ? pluginOptions.defaultLimit : 10);
    const useDefaultLimit = isNaN(options.limit) || options.limit < 0 || options.limit === 0 && pluginOptions && pluginOptions.dontAllowUnlimitedResults;
    const unlimited = options.limit === 0 && (!pluginOptions || !pluginOptions.dontAllowUnlimitedResults);
    options.limit = useDefaultLimit ? defaultLimit : options.limit;

    // Query documents
    const query = {$and: [generateCursorQuery(options), _query || {}]};

    // Request one extra result to check for a next/previous
    const promise = mongoObject.find(query, _projection, _options).sort(sort).limit(unlimited ? 0 : options.limit + 1);

    return promise;
  }

  /**
   * Peform a paginated find() request
   * @param {IPaginateOptions} options the pagination options
   * @param {Object} [_query] the mongo query
   * @param {Object} [_projection] the mongo projection
   * @param _options
   * @param {string | PopulateOptions | (string | PopulateOptions)[]} [_populate] the mongo populate
   */
  async function findPaged<T>(options: IPaginateOptions, _query?: Object, _projection?: Object, _options?: QueryOptions<T> | null | undefined, _populate?: string | PopulateOptions | (string | PopulateOptions)[]): Promise<IPaginateResult<T>> {
    // Find and populate docs
    const docs = await createFindPromise<T>(this, options, _query, _projection, _options).populate(_populate || []);

    if(pluginOptions && pluginOptions.dontReturnTotalDocs) {
      return prepareResponse<T>(docs, options);
    } else {
      const totalDocs = await this.countDocuments(_query).exec();
      return prepareResponse<T>(docs, options, totalDocs);
    }
  }

  /**
   * Explains a paginated find() request
   * @param {IPaginateOptions} options the pagination options
   * @param {VerboseMode} verbose the verbosity mode for explain()
   * @param {Object} [_query] the mongo query
   * @param {Object} [_projection] the mongo projection
   * @param _options
   */
  async function findPagedExplain<T>(options: IPaginateOptions, verbose?: VerboseMode, _query?: Object, _projection?: Object, _options?: QueryOptions<T> | null | undefined): Promise<any> {
    return await createFindPromise(this, options, _query, _projection, _options).explain(verbose);
  }

  function createAggregatePromise<T>(
    mongoCollection: Model<T>,
    options: IPaginateOptions,
    pipelineBefore: PipelineStage[],
    pipelineAfter: PipelineStage[] = []
  ) {
    // Determine sort and limit for pagination
    const sort = generateSort(options);

    const defaultLimit = (pluginOptions && pluginOptions.defaultLimit ? pluginOptions.defaultLimit : 10);
    const useDefaultLimit = isNaN(options.limit) || options.limit < 0 || options.limit === 0 && pluginOptions && pluginOptions.dontAllowUnlimitedResults;
    const unlimited = options.limit === 0 && (!pluginOptions || !pluginOptions.dontAllowUnlimitedResults);
    options.limit = useDefaultLimit ? defaultLimit : options.limit;

    // Apply pagination to the pipeline
    const paginatedPipeline = [
      ...pipelineBefore,
      ...generateAggregatePipeline(options),
      {$sort: sort as any},
      ...(!unlimited ? [{$limit: options.limit + 1}] : []),
      ...pipelineAfter
    ];

    // Execute the aggregate query
    const cursor = mongoCollection.aggregate<T>(paginatedPipeline);

    return cursor;
  }

  async function aggregatePaged<T>(
    options: IPaginateOptions,
    pipeline: PipelineStage[],
    pipelineAfter: PipelineStage[] = []
  ): Promise<IPaginateResult<T>> {
    // Execute the aggregate query
    const cursor = createAggregatePromise<T>(this, options, pipeline, pipelineAfter);

    // Fetch documents
    const docs = await cursor.exec();

    // Count total documents (if needed)
    let totalDocs = 0;
    if(pluginOptions && pluginOptions.dontReturnTotalDocs) {
      return prepareResponse<T>(docs, options);
    } else {
      const countPipeline = [...pipeline, {$group: {_id: null, count: {$sum: 1}}}];
      const countCursor = this.aggregate(countPipeline);
      const countResult = await countCursor.exec();
      totalDocs = countResult.length > 0 ? countResult[0].count : 0;
      return prepareResponse<T>(docs, options, totalDocs);
    }
  }

  schema.statics.findPaged = findPaged;
  schema.statics.findPagedExplain = findPagedExplain;
  schema.statics.aggregatePaged = aggregatePaged;
}

export * from './types';
