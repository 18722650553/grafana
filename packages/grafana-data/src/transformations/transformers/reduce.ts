import { DataTransformerID } from './ids';
import { DataTransformerInfo, MatcherConfig } from '../../types/transformations';
import { fieldReducers, reduceField, ReducerID } from '../fieldReducer';
import { alwaysFieldMatcher, notTimeFieldMatcher } from '../matchers/predicates';
import { DataFrame, Field, FieldType } from '../../types/dataFrame';
import { ArrayVector } from '../../vector/ArrayVector';
import { KeyValue } from '../../types/data';
import { guessFieldTypeForField } from '../../dataframe/processDataFrame';
import { getFieldMatcher } from '../matchers';
import { getFieldDisplayName } from '../../field';

export enum ReduceTransformerMode {
  SeriesToRows = 'seriesToRows', // default
  ReduceField = 'reduceField', // same structure, add additional row for each type
}

export interface ReduceTransformerOptions {
  reducers: ReducerID[];
  fields?: MatcherConfig; // Assume all fields
  mode?: ReduceTransformerMode;
  includeTimeField?: boolean;
}

export const reduceTransformer: DataTransformerInfo<ReduceTransformerOptions> = {
  id: DataTransformerID.reduce,
  name: 'Reduce',
  description: 'Reduce all rows or data points to a single value using a function like max, min, mean or last',
  defaultOptions: {
    reducers: [ReducerID.max],
  },

  /**
   * Return a modified copy of the series.  If the transform is not or should not
   * be applied, just return the input series
   */
  transformer: (options: ReduceTransformerOptions) => {
    const matcher = options.fields
      ? getFieldMatcher(options.fields)
      : options.includeTimeField && options.mode === ReduceTransformerMode.ReduceField
      ? alwaysFieldMatcher
      : notTimeFieldMatcher;
    const calculators = options.reducers && options.reducers.length ? fieldReducers.list(options.reducers) : [];
    const reducers = calculators.map(c => c.id);

    return (data: DataFrame[]) => {
      const processed: DataFrame[] = [];

      // Collapse all matching fields into a single row
      if (options.mode === ReduceTransformerMode.ReduceField) {
        for (const series of data) {
          const fields: Field[] = [];
          for (const field of series.fields) {
            if (matcher(field, series, data)) {
              const results = reduceField({
                field,
                reducers,
              });
              for (const reducer of reducers) {
                const value = results[reducer];
                const copy = {
                  ...field,
                  value: new ArrayVector([value]),
                };
                copy.state = undefined;
                if (reducers.length > 1) {
                  if (!copy.labels) {
                    copy.labels = {};
                  }
                  copy.labels['reducer'] = reducer;
                }
                fields.push(copy);
              }
            }
          }
          if (fields.length) {
            processed.push({
              ...series,
              fields,
              length: 1, // always one row
            });
          }
        }

        return processed;
      }

      for (const series of data) {
        const values: ArrayVector[] = [];
        const fields: Field[] = [];
        const byId: KeyValue<ArrayVector> = {};

        values.push(new ArrayVector()); // The name
        fields.push({
          name: 'Field',
          type: FieldType.string,
          values: values[0],
          config: {},
        });

        for (const info of calculators) {
          const vals = new ArrayVector();
          byId[info.id] = vals;
          values.push(vals);

          fields.push({
            name: info.name,
            type: FieldType.other, // UNKNOWN until after we call the functions
            values: values[values.length - 1],
            config: {},
          });
        }

        for (let i = 0; i < series.fields.length; i++) {
          const field = series.fields[i];

          if (matcher(field, series, data)) {
            const results = reduceField({
              field,
              reducers,
            });

            // Update the name list
            const fieldName = getFieldDisplayName(field, series, data);

            values[0].buffer.push(fieldName);

            for (const info of calculators) {
              const v = results[info.id];
              byId[info.id].buffer.push(v);
            }
          }
        }

        for (const f of fields) {
          const t = guessFieldTypeForField(f);

          if (t) {
            f.type = t;
          }
        }

        processed.push({
          ...series, // Same properties, different fields
          fields,
          length: values[0].length,
        });
      }

      return mergeResults(processed);
    };
  },
};

const mergeResults = (data: DataFrame[]) => {
  if (data.length <= 1) {
    return data;
  }

  const baseFrame = data[0];

  for (let seriesIndex = 1; seriesIndex < data.length; seriesIndex++) {
    const series = data[seriesIndex];

    for (const baseField of baseFrame.fields) {
      for (const field of series.fields) {
        if (baseField.type !== field.type || baseField.name !== field.name) {
          continue;
        }

        const baseValues: any[] = ((baseField.values as unknown) as ArrayVector).buffer;
        const values: any[] = ((field.values as unknown) as ArrayVector).buffer;
        ((baseField.values as unknown) as ArrayVector).buffer = baseValues.concat(values);
      }
    }
  }

  baseFrame.name = undefined;
  baseFrame.length = baseFrame.fields[0].values.length;

  return [baseFrame];
};
